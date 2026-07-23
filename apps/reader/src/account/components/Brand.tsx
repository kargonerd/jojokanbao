import { Link } from "react-router-dom";

export function Brand() {
  return (
    <Link to="/" className="archive-masthead" aria-label="返回 JOJO 看报">
      <span className="archive-masthead__name">JOJO看报</span>
      <span className="archive-masthead__caption">数字报刊馆藏</span>
    </Link>
  );
}
