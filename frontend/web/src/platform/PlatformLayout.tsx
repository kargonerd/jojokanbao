import { Outlet } from "react-router-dom";
import { PlatformHeader } from "./PlatformHeader";
import "./styles.css";

export function PlatformLayout() {
  return (
    <div className="platform-shell">
      <PlatformHeader />
      <Outlet />
    </div>
  );
}
