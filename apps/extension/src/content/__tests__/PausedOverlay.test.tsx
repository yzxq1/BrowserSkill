import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayController, shouldShowPausedOverlay } from "../overlay-controller";
import { PausedOverlay } from "../PausedOverlay";

afterEach(cleanup);
describe("paused Continue UI", () => {
  it("does not block the page and refuses script-generated clicks", () => {
    const onResume = vi.fn();
    const { container } = render(
      <PausedOverlay visible resuming={false} error={null} onResume={onResume} />,
    );
    expect(container.querySelector("[data-slot='control-overlay-blocker']")).toBeNull();
    const button = container.querySelector("button")!;
    fireEvent.click(button);
    expect(onResume).not.toHaveBeenCalled();
  });
  it("disables Continue while pending and displays explicit failure", () => {
    const { container } = render(
      <PausedOverlay visible resuming error="busy" onResume={() => {}} />,
    );
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector("[role='alert']")).not.toBeNull();
  });
  it("only shows paused tasks and honors the control-hints preference", () => {
    const state = new OverlayController();
    expect(shouldShowPausedOverlay(state.snapshot())).toBe(false);
    state.activateAgentSession("one");
    expect(shouldShowPausedOverlay(state.snapshot())).toBe(false);
    state.applyAgentControlMode("one", "paused");
    expect(shouldShowPausedOverlay(state.snapshot())).toBe(true);
    expect(state.snapshot().controlVisible).toBe(false);
    state.setControlHintsHidden(true);
    expect(shouldShowPausedOverlay(state.snapshot())).toBe(false);
  });
});
