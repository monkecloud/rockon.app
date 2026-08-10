// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ZoomableImageViewer } from "../components/ZoomableImageViewer.jsx";

// §14.11 priority 6, pointer-driven. ZoomableImageViewer writes its
// transform straight to the DOM node via a ref instead of React state (see
// the component's own comment: setState per pointermove made pinch/drag
// glitchy on mobile), so these tests read img.style.transform rather than
// props/re-render output.
function renderViewer(props = {}) {
  const utils = render(
    <ZoomableImageViewer title="V4 · Golden Overhang" photoUrl="data:image/png;base64,xyz" {...props} />
  );
  const img = utils.container.querySelector("img");
  const stage = img.parentElement;
  return { ...utils, img, stage };
}

describe("ZoomableImageViewer — single-pointer drag", () => {
  it("translates the image by the pointer's movement since pointerdown", () => {
    const { img, stage } = renderViewer();

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 130, clientY: 80 });

    expect(img.style.transform).toBe("translate(30px, -20px) scale(1)");
  });

  it("stops translating once the pointer is released", () => {
    const { img, stage } = renderViewer();

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 40, clientY: 0 });
    expect(img.style.transform).toContain("translate(40px, 0px)");

    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 999, clientY: 999 });
    expect(img.style.transform).toContain("translate(40px, 0px)");
  });
});

describe("ZoomableImageViewer — two-finger pinch", () => {
  it("scales up as the two pointers move apart, clamped to 4x", () => {
    const { img, stage } = renderViewer();

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 110, clientY: 100 }); // 10px apart

    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 0, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 410, clientY: 100 }); // far apart

    expect(img.style.transform).toContain("scale(4)");
  });

  it("scales back down as the two pointers move together, floored at 1x", () => {
    const { img, stage } = renderViewer();

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 0, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 400, clientY: 100 }); // 400px apart

    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 195, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 205, clientY: 100 }); // 10px apart

    expect(img.style.transform).toContain("scale(1)");
  });
});

describe("ZoomableImageViewer — wheel zoom", () => {
  it("zooms in on wheel-up and back out on wheel-down, clamped to [1, 4]", () => {
    const { img, stage } = renderViewer();

    fireEvent.wheel(stage, { deltaY: -100 });
    expect(img.style.transform).toContain("scale(1.15)");

    fireEvent.wheel(stage, { deltaY: 100 });
    fireEvent.wheel(stage, { deltaY: 100 });
    // Back below the starting 1x floor — clamped, not negative.
    expect(img.style.transform).toContain("scale(1)");
  });
});
