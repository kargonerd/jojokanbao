export function LoadingPage({ label = "正在核验账号…" }: { label?: string }) {
  return (
    <div className="flex min-h-[55vh] items-center justify-center px-5">
      <div className="text-center">
        <span className="mx-auto mb-5 block h-9 w-9 animate-spin border-2 border-rule border-t-red" />
        <p className="text-sm font-bold tracking-[0.12em] text-muted">{label}</p>
      </div>
    </div>
  );
}
