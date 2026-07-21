interface LoadingSpinnerProps {
  text?: string;
  fullscreen?: boolean;
}

export function LoadingSpinner({ text, fullscreen = false }: LoadingSpinnerProps) {
  const content = (
    <div className="text-center">
      <div className="w-6 h-6 border-2 border-red border-t-transparent rounded-full animate-spin mx-auto mb-3" />
      {text && <p className="text-sm font-bold text-red tracking-wide m-0">{text}</p>}
    </div>
  );

  if (fullscreen) {
    return <div className="fixed inset-0 z-50 flex items-center justify-center bg-paper/90">{content}</div>;
  }
  return <div className="flex items-center justify-center py-12">{content}</div>;
}
