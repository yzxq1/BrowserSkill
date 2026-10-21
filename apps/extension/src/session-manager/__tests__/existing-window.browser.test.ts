// @vitest-environment node
// Opt-in; owns a fresh isolated profile, never connects to the user's browser.
// BSK_EXISTING_WINDOW_CHROME=/path/to/chrome-for-testing
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Send = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  sessionId?: string,
) => Promise<T>;

const entry = `
import { SessionManager } from '@/session-manager/manager';
import { AgentWindowRouting } from '@/session-manager/window-routing';
import { handleSessionStart, handleSessionStop } from '@/tools/session';
import { handleTabCreate, handleTabBorrow, handleTabReturn, chromeTabMutationApi } from '@/tools/tabs';
import { handleNavigate } from '@/tools/navigation';
import { handleSnapshot } from '@/tools/observation';
import { ChromiumCdp } from '@/browser-driver/chromium-cdp';
import { ToolDispatcher } from '@/tools/dispatcher';
const check=(condition,message)=>{if(!condition)throw new Error(message)};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(fn)=>{for(let i=0;i<150;i++){if(await fn())return;await sleep(20);}throw new Error('fixture timed out')};
globalThis.run=async(url)=>{
 globalThis.phase='controller';
 const controller=await chrome.tabs.getCurrent();
 await chrome.windows.create({tabId:controller.id,type:'popup',focused:false});
 const windows=await chrome.windows.getAll({windowTypes:['normal']});
 const user=windows[0]; check(user,'missing user window');
 const [original]=await chrome.tabs.query({windowId:user.id,active:true});
 await chrome.tabs.update(original.id,{url:url+'/user'});
 await chrome.windows.update(user.id,{focused:true});
 const manager=new SessionManager();
 const router=new AgentWindowRouting(manager,chrome);
 const cdp=new ChromiumCdp(chrome.debugger);
 const deps={cdp,tabsApi:chrome.tabs};
 try {
 globalThis.phase='start';
  const before=await chrome.tabs.query({windowId:user.id});
  const count=(await chrome.windows.getAll()).length;
  const start=await handleSessionStart(manager,{session_id:'real-window',window_id:-1});
  check(!start.code,JSON.stringify(start));
  const ctx=manager.get('real-window'),taskId=start.default_tab_id;
  router.sync();
  check(start.agent_window_id===user.id,'did not reuse current user window');
  check((await chrome.windows.getAll()).length===count,'created a new window');
  check((await chrome.tabs.get(original.id)).active,'changed user active tab');
  check(!(await chrome.tabs.get(taskId)).active,'task page was activated');
  check((await chrome.tabs.get(taskId)).index===before.length,'task not appended at end');
 globalThis.phase='navigation';
  const navigation=await handleNavigate(manager,{session_id:ctx.sessionId,url:url+'/task'},deps);
  check(!navigation.code,JSON.stringify(navigation));
 globalThis.phase='snapshot';
  const snapshot=await handleSnapshot(manager,{session_id:ctx.sessionId},deps);
  check(!snapshot.code&&snapshot.text.includes('Task-owned fixture'),JSON.stringify(snapshot));
 globalThis.phase='foreign-read';
  const foreign=await handleSnapshot(manager,{session_id:ctx.sessionId,tab_id:original.id},deps);
  check(foreign.code==='permission_denied','unowned user page was readable');
 globalThis.phase='extra-tab';
  const extra=await handleTabCreate(manager,{session_id:ctx.sessionId,url:url+'/extra'},{tabs:chromeTabMutationApi,cdp});
  check(!extra.code,JSON.stringify(extra));
  check(!(await chrome.tabs.get(extra.tab_id)).active,'extra task page activated');
  let approvals=0;
 globalThis.phase='borrow';
  const borrow=await handleTabBorrow(manager,{session_id:ctx.sessionId,tab_id:original.id},{tabs:chromeTabMutationApi,cdp,approveBorrow:async()=>{approvals++;return true;}});
  check(!borrow.code&&approvals===1,JSON.stringify(borrow));
  check((await chrome.tabs.get(original.id)).windowId===user.id,'borrow moved user page');
 globalThis.phase='return';
  const returned=await handleTabReturn(manager,{session_id:ctx.sessionId,tab_id:original.id},{tabs:chromeTabMutationApi,cdp});
  check(!returned.code&&!ctx.borrowedTabs.has(original.id),'return failed');
  check((await chrome.tabs.get(original.id)).windowId===user.id,'return moved user page');
 globalThis.phase='interrupt';
  let receive;const replies=[];
  const transport={send:frame=>replies.push(frame),onMessage:fn=>{receive=fn;return{dispose(){}}},disconnect:async()=>{}};
  const dispatcher=new ToolDispatcher({transport,sessions:manager,cdp});dispatcher.start();
  dispatcher.interruptSession(ctx.sessionId);
  for(let i=0;i<2;i++){
   receive({id:'blocked-'+i,method:'tool.navigate',params:{session_id:ctx.sessionId,url:url+'/bad'}});
   await wait(()=>replies.some(r=>r.id==='blocked-'+i));
   check(replies.find(r=>r.id==='blocked-'+i).error.code==='user_aborted','pause was consumed');
  }
 globalThis.phase='resume';
  receive({id:'resume',method:'tool.session_resume',params:{session_id:ctx.sessionId}});
  await wait(()=>replies.some(r=>r.id==='resume'));
  check(replies.find(r=>r.id==='resume').result?.resumed===true,'explicit resume failed');
  check(manager.get(ctx.sessionId)===ctx&&ctx.defaultTabId===taskId,'resume replaced session or page');
  check((await chrome.tabs.get(taskId)).url===url+'/task','pause changed task URL');
  dispatcher.stop();
  const ids=(await chrome.tabs.query({windowId:user.id})).map(t=>t.id);
 globalThis.phase='stop';
  const stop=await handleSessionStop(manager,{session_id:ctx.sessionId},{cdp,tabManagement:{tabs:chromeTabMutationApi},tabsQuery:chrome.tabs});
  check(!stop.code&&stop.window_released,'stop did not release user window');
  const after=(await chrome.tabs.query({windowId:user.id})).map(t=>t.id);
  check(JSON.stringify(ids)===JSON.stringify(after),'stop deleted pages');
  check((await chrome.tabs.get(original.id)).active,'user selection changed');
  check(!manager.has(ctx.sessionId),'session authority remained after stop');
  return {windowId:user.id,taskTabId:taskId,retainedTabs:after.length,checks:'append,focus,ownership,borrow,interrupt,resume,stop'};
 } finally {router.dispose();await cdp.detachAll();cdp.dispose();}
};`;

describe.skipIf(!process.env.BSK_EXISTING_WINDOW_CHROME)(
  "existing user window real-browser regression",
  () => {
    it("appends without activation, enforces ownership and resumes the same page", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "bsk-existing-window-"));
      const server = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<!doctype html><h1>${req.url === "/user" ? "Private user fixture" : "Task-owned fixture"}</h1>`,
        );
      });
      try {
        const require = createRequire(import.meta.url);
        const { build } = await import(
          require.resolve("vite", { paths: [require.resolve("vitest")] })
        );
        await writeFile(path.join(directory, "entry.js"), entry);
        await build({
          configFile: false,
          logLevel: "error",
          define: {
            __BSK_EXT_VERSION__: JSON.stringify("0.3.3"),
            __BSK_DAEMON_WS_URL__: JSON.stringify("ws://127.0.0.1:1"),
          },
          resolve: {
            alias: {
              "@": path.resolve("src"),
              "@browser-skill/i18n": path.resolve("../../packages/i18n/src/index.ts"),
            },
          },
          build: {
            outDir: directory,
            emptyOutDir: false,
            lib: {
              entry: path.join(directory, "entry.js"),
              formats: ["iife"],
              name: "Regression",
              fileName: () => "regression.js",
            },
          },
        });
        await writeFile(
          path.join(directory, "manifest.json"),
          JSON.stringify({
            manifest_version: 3,
            name: "Existing window regression",
            version: "1.0",
            background: { service_worker: "worker.js" },
            permissions: ["debugger", "tabs", "scripting", "webNavigation", "storage"],
            host_permissions: ["http://127.0.0.1/*"],
          }),
        );
        await writeFile(
          path.join(directory, "worker.js"),
          "chrome.runtime.onInstalled.addListener(() => {});",
        );
        await writeFile(
          path.join(directory, "boot.js"),
          "globalThis.errors=[];addEventListener('error',e=>globalThis.errors.push(e.message));",
        );
        await writeFile(
          path.join(directory, "regression.html"),
          '<script src="boot.js"></script><script src="regression.js"></script>',
        );
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          {
            executable: process.env.BSK_EXISTING_WINDOW_CHROME,
            deviceScale: 1,
            zoom: 1,
            extensionPath: directory,
            headless: true,
            onEvent: (event: { method?: string; params?: unknown }) => {
              if (
                [
                  "Runtime.exceptionThrown",
                  "Target.detachedFromTarget",
                  "Inspector.detached",
                ].includes(event.method ?? "")
              ) {
                console.log("browser diagnostic", JSON.stringify(event));
              }
            },
          },
          async (send: Send) => {
            let origin = "";
            await expect
              .poll(
                async () => {
                  const { targetInfos } = await send<{
                    targetInfos: { type: string; url: string }[];
                  }>("Target.getTargets");
                  const worker = targetInfos.find(
                    (t) => t.type === "service_worker" && t.url.endsWith("/worker.js"),
                  );
                  origin = worker ? worker.url.slice(0, -"/worker.js".length) : "";
                  return origin;
                },
                { timeout: 10000 },
              )
              .not.toBe("");
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: `${origin}/regression.html`,
              background: true,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            // Exempt only the controller from background freezing; task/user tabs
            // still exercise their real visibility and focus behavior.
            console.log("existing-window regression: controller attached");
            await send("Runtime.enable", {}, sessionId);
            await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
            const evaluate = async (expression: string) => {
              const result = await send<{ result: { value: unknown }; exceptionDetails?: unknown }>(
                "Runtime.evaluate",
                { expression, returnByValue: true },
                sessionId,
              );
              expect(result.exceptionDetails).toBeUndefined();
              return result.result.value;
            };
            try {
              await expect
                .poll(() => evaluate("typeof globalThis.run"), { timeout: 10000 })
                .toBe("function");
            } catch {
              throw new Error(
                `Browser fixture initialization failed: ${JSON.stringify(await evaluate("({errors:globalThis.errors,url:location.href})"))}`,
              );
            }
            await evaluate(
              `globalThis.run(${JSON.stringify(url)}).then(value=>globalThis.done={value},error=>globalThis.done={error:error.stack});void 0`,
            );
            let done: { value?: unknown; error?: string } | undefined;
            let lastPhase = "";
            await expect
              .poll(
                async () => {
                  const state = (await evaluate(
                    "({done:globalThis.done,phase:globalThis.phase})",
                  )) as { done?: typeof done; phase?: string };
                  if (state.phase && state.phase !== lastPhase) {
                    lastPhase = state.phase;
                    console.log(`existing-window regression: ${lastPhase}`);
                  }
                  done = state.done;
                  return done;
                },
                { timeout: 30000 },
              )
              .toBeTruthy();
            expect(done?.error).toBeUndefined();
            expect(done?.value).toMatchObject({ retainedTabs: 3 });
          },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 60000);
  },
);
