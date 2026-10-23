// @vitest-environment node
// Native trusted clicks in an isolated Chrome profile; no user's browser is used.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import React from 'react';
import {createRoot} from 'react-dom/client';
import {i18n} from '@browser-skill/i18n';
import {I18nextProvider} from '@browser-skill/i18n/react';
import {PausedOverlay} from '@/content/PausedOverlay';
import {ResumeTasks} from '@/entrypoints/popup/resume-tasks';
import {SessionManager} from '@/session-manager/manager';
import {ToolDispatcher} from '@/tools/dispatcher';
import {SessionControlBridge} from '@/lib/session-control-bridge';
import {sendSessionControl,SESSION_CONTROL_MESSAGE} from '@/lib/session-control-client';
globalThis.run=async()=>{
 await i18n.changeLanguage('zh-CN');
 const manager=new SessionManager();const user=await chrome.windows.getCurrent();
 const ctx=await manager.start('ui-task',{windowId:user.id});
 const handlers=new Set();let bridge,mode='success',pendingAck=null,confirmation=null;
 const state={paused:true,resuming:false,error:null,resumed:0,requests:0};
 const emit=frame=>{for(const fn of handlers)fn(frame)};
 const transport={state:'connected',onMessage:fn=>{handlers.add(fn);return{dispose:()=>handlers.delete(fn)}},
  onConnectionStateChange:()=>({dispose(){}}),send:frame=>{
   if(frame.method==='session.resume'){
    state.requests++;pendingAck=frame.id;
    if(mode==='busy')emit({id:frame.id,error:{code:'timeout',message:'busy',data:{reason:'session_busy'}}});
    else emit({id:'local-confirmation',method:'tool.session_resume',params:{session_id:ctx.sessionId}});
   }else if(frame.id==='local-confirmation')confirmation=frame;
  }};
 const dispatcher=new ToolDispatcher({sessions:manager,transport,onBrowserControlResumed:()=>{
  if(!bridge?.isResuming(ctx.sessionId)){state.paused=false;render();}
 }});dispatcher.start();dispatcher.interruptSession(ctx.sessionId);
 const root=createRoot(document.body.appendChild(document.createElement('div')));
 const resume=async()=>{
  state.resuming=true;state.error=null;render();
  const reply=await sendSessionControl({kind:SESSION_CONTROL_MESSAGE,action:'resume',sessionId:ctx.sessionId});
  state.resuming=false;if(!reply.ok)state.error=reply.error;render();
 };
 function render(){root.render(React.createElement(I18nextProvider,{i18n},React.createElement(React.Fragment,null,
  React.createElement(PausedOverlay,{visible:state.paused,resuming:state.resuming,error:state.error,onResume:resume}),
  React.createElement(ResumeTasks,{enabled:true})
 )));}
 bridge=new SessionControlBridge({sessions:manager,dispatcher,transport,onPaused:()=>{state.paused=true;render()},onResumed:()=>{state.paused=false;state.resumed++;render()}});
 chrome.runtime.sendMessage=message=>bridge.handle(message,{id:chrome.runtime.id,url:location.href});
 globalThis.inspect=()=>({...state,pending:!!confirmation,localPaused:dispatcher.isSessionPaused(ctx.sessionId),sameTask:manager.get(ctx.sessionId)===ctx,tabId:ctx.defaultTabId});
 globalThis.confirm=()=>{if(!confirmation)throw new Error('no confirmation');const frame=confirmation;confirmation=null;emit({id:pendingAck,...('error'in frame?{error:frame.error}:{result:frame.result})});};
 globalThis.reset=value=>{mode=value;dispatcher.interruptSession(ctx.sessionId);state.paused=true;state.error=null;state.resuming=false;render();};
 render();return {taskTabId:ctx.defaultTabId};
};`;

describe.skipIf(!process.env.BSK_RESUME_UI_CHROME)(
  "Continue button native-browser interaction",
  () => {
    it("requires a trusted click, waits for both acknowledgements and supports the popup", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "bsk-resume-ui-"));
      try {
        const require = createRequire(import.meta.url);
        const { build } = await import(
          require.resolve("vite", { paths: [require.resolve("vitest")] })
        );
        const { default: react } = await import("@vitejs/plugin-react");
        await writeFile(path.join(directory, "entry.js"), entry);
        await build({
          configFile: false,
          logLevel: "error",
          plugins: [react()],
          define: {
            "process.env.NODE_ENV": JSON.stringify("development"),
            __BSK_EXT_VERSION__: JSON.stringify("0.3.3"),
            __BSK_DAEMON_WS_URL__: JSON.stringify("ws://127.0.0.1:1"),
          },
          resolve: {
            alias: {
              react: path.dirname(require.resolve("react/package.json")),
              "react-dom": path.dirname(require.resolve("react-dom/package.json")),
              "@": path.resolve("src"),
              "@browser-skill/i18n/react": path.resolve("../../packages/i18n/src/react.tsx"),
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
              fileName: () => "fixture.js",
            },
          },
        });
        await writeFile(
          path.join(directory, "manifest.json"),
          JSON.stringify({
            manifest_version: 3,
            name: "Resume UI regression",
            version: "1.0",
            background: { service_worker: "worker.js" },
            permissions: ["tabs", "debugger", "storage"],
          }),
        );
        await writeFile(
          path.join(directory, "worker.js"),
          "chrome.runtime.onInstalled.addListener(()=>{});",
        );
        await writeFile(
          path.join(directory, "boot.js"),
          "globalThis.errors=[];addEventListener('error',e=>errors.push(e.message));",
        );
        await writeFile(
          path.join(directory, "popup.html"),
          '<script src="boot.js"></script><script src="fixture.js"></script>',
        );
        const { withChrome } = await import(
          new URL(
            "../../../../../evals/browser/cases/regression/snapshot-coordinates/chrome.mjs",
            import.meta.url,
          ).href
        );
        await withChrome(
          {
            executable: process.env.BSK_RESUME_UI_CHROME,
            deviceScale: 1,
            zoom: 1,
            extensionPath: directory,
            headless: true,
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
                  origin = worker ? worker.url.slice(0, -10) : "";
                  return origin;
                },
                { timeout: 10000 },
              )
              .not.toBe("");
            const { targetId } = await send<{ targetId: string }>("Target.createTarget", {
              url: `${origin}/popup.html`,
              background: false,
            });
            const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", {
              targetId,
              flatten: true,
            });
            await send("Target.activateTarget", { targetId });
            await send("Runtime.enable", {}, sessionId);
            await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
            const evaluate = async (expression: string) => {
              let response: { result: { value: any }; exceptionDetails?: unknown };
              try {
                response = await send(
                  "Runtime.evaluate",
                  { expression, returnByValue: true, awaitPromise: true },
                  sessionId,
                );
              } catch (error) {
                throw new Error(`Evaluation failed (${expression}): ${error}`);
              }
              expect(response.exceptionDetails).toBeUndefined();
              return response.result.value;
            };
            try {
              await expect
                .poll(() => evaluate("typeof globalThis.run"), { timeout: 10000 })
                .toBe("function");
            } catch {
              throw new Error(
                `Fixture initialization failed: ${JSON.stringify(await evaluate("({errors:globalThis.errors,url:location.href})"))}`,
              );
            }
            const initial = await evaluate("globalThis.run()");
            const click = async (selector: string) => {
              const rect = await evaluate(
                `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
              );
              await send(
                "Input.dispatchMouseEvent",
                { type: "mousePressed", button: "left", clickCount: 1, ...rect },
                sessionId,
              );
              await send(
                "Input.dispatchMouseEvent",
                { type: "mouseReleased", button: "left", clickCount: 1, ...rect },
                sessionId,
              );
            };
            try {
              await expect
                .poll(() =>
                  evaluate("!!document.querySelector('[data-slot=paused-overlay-resume]')"),
                )
                .toBe(true);
            } catch {
              throw new Error(
                `UI render failed: ${JSON.stringify(await evaluate("({errors:globalThis.errors,text:document.body.innerText,state:inspect()})"))}`,
              );
            }
            await evaluate("document.querySelector('[data-slot=paused-overlay-resume]').click()");
            expect((await evaluate("inspect()")).requests).toBe(0);
            await click("[data-slot=paused-overlay-resume]");
            await expect.poll(() => evaluate("inspect().pending")).toBe(true);
            expect((await evaluate("inspect()")).resumed).toBe(0);
            expect(
              await evaluate(
                "document.querySelector('[data-slot=paused-overlay-resume]').disabled",
              ),
            ).toBe(true);
            await evaluate("confirm()");
            await expect.poll(() => evaluate("inspect().resumed")).toBe(1);
            expect((await evaluate("inspect()")).tabId).toBe(initial.taskTabId);
            expect((await evaluate("inspect()")).sameTask).toBe(true);
            await evaluate("reset('busy')");
            await expect
              .poll(() => evaluate("!!document.querySelector('[data-slot=popup-resume-task]')"))
              .toBe(true);
            await click("[data-slot=popup-resume-task]");
            await expect
              .poll(() =>
                evaluate("!!document.querySelector('[data-slot=popup-paused-tasks] [role=alert]')"),
              )
              .toBe(true);
            expect((await evaluate("inspect()")).localPaused).toBe(true);
            expect((await evaluate("inspect()")).resumed).toBe(1);
            await evaluate("reset('success')");
            await click("[data-slot=popup-resume-task]");
            await expect.poll(() => evaluate("inspect().pending")).toBe(true);
            await evaluate("confirm()");
            await expect.poll(() => evaluate("inspect().resumed")).toBe(2);
            expect((await evaluate("inspect()")).tabId).toBe(initial.taskTabId);
          },
        );
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 60000);
  },
);
