import { useEffect, useState, type ReactNode } from "react";

export interface NavItem {
  label: string;
  href?: string;
  children?: { label: string; href: string }[];
}

interface NavBarProps {
  items: NavItem[];
  actions?: { label: string; href: string }[];
  trailing?: ReactNode;
  mobileTitle?: string;
  mobileTitleHref?: string;
  onNavigate: (href: string) => void;
  isActive: (href: string) => boolean;
}

export function NavBar({
  items,
  actions = [],
  trailing,
  mobileTitle,
  mobileTitleHref = "/",
  onNavigate,
  isActive,
}: NavBarProps) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!openDropdown) return;
    const handler = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest("[data-nav-dropdown]")) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openDropdown]);

  return (
    <nav className="h-full flex items-center px-6 bg-paper font-serif relative" onMouseLeave={() => setOpenDropdown(null)}>
      {mobileTitle && (
        <a
          href={mobileTitleHref}
          onClick={(e) => { e.preventDefault(); onNavigate(mobileTitleHref); setMobileOpen(false); }}
          className="md:hidden text-base font-bold tracking-wide text-red no-underline"
        >
          {mobileTitle}
        </a>
      )}

      {/* Desktop */}
      <ul className="hidden md:flex items-center h-full gap-0 list-none m-0 p-0">
        {items.map((item) => (
          <li key={item.label} className="relative h-full flex items-center" data-nav-dropdown>
            {item.href ? (
              <a
                href={item.href}
                onMouseEnter={() => setOpenDropdown(null)}
                onClick={(e) => { e.preventDefault(); onNavigate(item.href!); }}
                className={`relative h-full flex items-center px-5 text-sm font-bold tracking-wide no-underline transition-colors hover:text-red ${isActive(item.href) ? "text-red" : "text-ink"}`}
              >
                {item.label}
                {isActive(item.href) && <span className="absolute bottom-2.5 left-5 right-5 h-0.5 bg-red" />}
              </a>
            ) : (
              <>
                <button
                  className={`relative h-full flex items-center px-5 text-sm font-bold tracking-wide border-0 bg-transparent transition-colors hover:text-red cursor-pointer ${item.children?.some((c) => isActive(c.href)) ? "text-red" : "text-ink"}`}
                  onMouseEnter={() => setOpenDropdown(item.label)}
                  onFocus={() => setOpenDropdown(item.label)}
                  onClick={() => setOpenDropdown(item.label)}
                  aria-haspopup="menu"
                  aria-expanded={openDropdown === item.label}
                >
                  {item.label}
                  <svg className="ml-1 w-3 h-3 opacity-50" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5l3 3 3-3" /></svg>
                  {item.children?.some((c) => isActive(c.href)) && <span className="absolute bottom-2.5 left-5 right-5 h-0.5 bg-red" />}
                </button>
                {openDropdown === item.label && (
                  <ul className="absolute top-full left-0 min-w-[168px] m-0 p-0 list-none bg-paper border-2 border-red shadow-[4px_4px_0_rgba(139,26,26,.14)] z-50 animate-[dropIn_.15s_ease-out]">
                    {item.children!.map((child, i) => (
                      <li key={child.href} className={i > 0 ? "border-t border-red/20" : ""}>
                        <a
                          href={child.href}
                          onClick={(e) => { e.preventDefault(); onNavigate(child.href); setOpenDropdown(null); }}
                          className="block px-5 py-3 text-sm font-bold text-red no-underline transition-all duration-[180ms] hover:bg-red hover:text-cream"
                        >
                          {child.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      {/* Desktop utility area */}
      {(trailing || actions.length > 0) && (
        <div className="ml-auto hidden h-full items-center md:flex">
          {trailing && <div className="hidden lg:block">{trailing}</div>}
          {actions.map((action) => (
            <a
              key={action.href}
              href={action.href}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(action.href);
              }}
              className={`ml-5 flex h-full items-center border-l border-rule px-5 text-sm font-bold tracking-wide no-underline transition-colors hover:text-red ${
                isActive(action.href) ? "text-red" : "text-ink"
              }`}
            >
              {action.label}
            </a>
          ))}
        </div>
      )}

      {/* Mobile hamburger */}
      <button className="md:hidden ml-auto p-2 border-0 bg-transparent text-ink" onClick={() => setMobileOpen(!mobileOpen)} aria-label="菜单">
        <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
          {!mobileOpen
            ? <path fillRule="evenodd" d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z" />
            : <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" />}
        </svg>
      </button>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="absolute top-full left-0 right-0 bg-paper border-b border-rule-dark z-50 md:hidden">
          <ul className="list-none m-0 p-4 space-y-1">
            {items.map((item) =>
              item.href ? (
                <li key={item.label}>
                  <a href={item.href} onClick={(e) => { e.preventDefault(); onNavigate(item.href!); setMobileOpen(false); }} className={`block py-2 px-3 text-sm font-bold no-underline hover:text-red ${isActive(item.href) ? "text-red" : "text-ink"}`}>
                    {item.label}
                  </a>
                </li>
              ) : (
                <li key={item.label}>
                  <p className="pt-3 pb-1 px-3 text-xs font-bold text-muted tracking-widest uppercase m-0">{item.label}</p>
                  {item.children?.map((child) => (
                    <a key={child.href} href={child.href} onClick={(e) => { e.preventDefault(); onNavigate(child.href); setMobileOpen(false); }} className={`block py-2 px-6 text-sm font-bold no-underline hover:text-red ${isActive(child.href) ? "text-red" : "text-ink"}`}>
                      {child.label}
                    </a>
                  ))}
                </li>
              )
            )}
            {actions.length > 0 && (
              <li className="mt-2 border-t border-rule pt-2">
                {actions.map((action) => (
                  <a
                    key={action.href}
                    href={action.href}
                    onClick={(event) => {
                      event.preventDefault();
                      onNavigate(action.href);
                      setMobileOpen(false);
                    }}
                    className={`block px-3 py-2 text-sm font-bold no-underline hover:text-red ${
                      isActive(action.href) ? "text-red" : "text-ink"
                    }`}
                  >
                    {action.label}
                  </a>
                ))}
              </li>
            )}
          </ul>
        </div>
      )}
    </nav>
  );
}
