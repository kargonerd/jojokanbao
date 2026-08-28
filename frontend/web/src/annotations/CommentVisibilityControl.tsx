import type { AnnotationVisibility } from "./types";
import "./annotations.css";

interface CommentVisibilityControlProps {
  value: AnnotationVisibility;
  onChange: (value: AnnotationVisibility) => void;
  disabled?: boolean;
}

export function CommentVisibilityControl({ value, onChange, disabled = false }: CommentVisibilityControlProps) {
  return <div className="annotation-visibility" role="radiogroup" aria-label="评论可见范围">
    <span className="annotation-visibility__label" aria-hidden="true">可见范围</span>
    <button type="button" role="radio" aria-checked={value === "public"} disabled={disabled} onClick={() => onChange("public")}>公开</button>
    <button type="button" role="radio" aria-checked={value === "private"} disabled={disabled} onClick={() => onChange("private")}>仅自己可见</button>
  </div>;
}
