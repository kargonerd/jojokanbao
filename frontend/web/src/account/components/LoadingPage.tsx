export function LoadingPage({ label = "正在打开读者入口…" }: { label?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-5">
      <div className="text-center">
        <span className="mx-auto mb-5 block h-9 w-9 animate-spin border-2 border-rule border-t-red" />
        <p className="text-sm font-bold tracking-[0.12em] text-muted">{label}</p>
      </div>
    </main>
  );
}
