import { useRef, type ButtonHTMLAttributes } from "react";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onPointerDown" | "onPointerUp" | "onPointerCancel"> & {
  onActivate: () => void;
};

/** Handles browsers that deliver pointerup to a newly focused window but omit click. */
export function ReliableButton({ onActivate, ...props }: Props) {
  const hadPointerDown = useRef(false);
  const suppressClick = useRef(false);

  return <button
    {...props}
    onPointerDown={event => { if (event.button === 0) hadPointerDown.current = true; }}
    onPointerCancel={() => { hadPointerDown.current = false; }}
    onPointerUp={event => {
      if (event.button !== 0 || event.currentTarget.disabled) return;
      if (!hadPointerDown.current) {
        suppressClick.current = true;
        onActivate();
        window.setTimeout(() => { suppressClick.current = false; }, 0);
      }
      hadPointerDown.current = false;
    }}
    onClick={() => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      onActivate();
    }}
  />;
}
