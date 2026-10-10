import { useEffect } from "react";

/** Keep the page in place while any site modal is open, including nested dialogs. */
export function ModalScrollLock() {
  useEffect(() => {
    let restore: (() => void) | null = null;

    const sync = () => {
      const hasModal = Boolean(document.querySelector(".modal-backdrop, dialog[open]"));
      if (hasModal && !restore) {
        const body = document.body;
        const html = document.documentElement;
        const x = window.scrollX;
        const y = window.scrollY;
        const gutter = Math.max(0, window.innerWidth - html.clientWidth);
        const previous = {
          htmlOverflow: html.style.overflow,
          bodyOverflow: body.style.overflow,
          bodyPosition: body.style.position,
          bodyTop: body.style.top,
          bodyLeft: body.style.left,
          bodyWidth: body.style.width,
          bodyPaddingRight: body.style.paddingRight,
        };
        html.style.overflow = "hidden";
        body.style.overflow = "hidden";
        body.style.position = "fixed";
        body.style.top = `${-y}px`;
        body.style.left = `${-x}px`;
        body.style.width = "100%";
        if (gutter) body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight || "0") + gutter}px`;
        restore = () => {
          html.style.overflow = previous.htmlOverflow;
          body.style.overflow = previous.bodyOverflow;
          body.style.position = previous.bodyPosition;
          body.style.top = previous.bodyTop;
          body.style.left = previous.bodyLeft;
          body.style.width = previous.bodyWidth;
          body.style.paddingRight = previous.bodyPaddingRight;
          window.scrollTo(x, y);
        };
      } else if (!hasModal && restore) {
        restore();
        restore = null;
      }
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    sync();
    return () => { observer.disconnect(); restore?.(); };
  }, []);
  return null;
}
