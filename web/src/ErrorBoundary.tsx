import { Code2, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Codex UI crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="crash-screen" aria-label="页面出现异常">
          <div className="brand-mark"><Code2 size={24} /></div>
          <h2>页面出现异常</h2>
          <p>{this.state.error.message || String(this.state.error)}</p>
          <button
            className="primary-button"
            onClick={() => {
              try {
                window.localStorage.removeItem("codex-ui.selected-thread");
                window.localStorage.removeItem("codex-ui.selected-workspace");
              } catch {
                // Storage 不可用时忽略
              }
              window.location.reload();
            }}
          >
            <RefreshCw size={16} />重新加载
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
