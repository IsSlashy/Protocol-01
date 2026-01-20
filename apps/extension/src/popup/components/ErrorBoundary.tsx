import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Extension error:', error, errorInfo);
  }

  private handleReset = () => {
    // Clear localStorage and reload
    localStorage.clear();
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="w-[360px] h-[600px] bg-p01-void flex flex-col items-center justify-center p-6">
          <div className="w-12 h-12 mb-4 bg-red-500/20 border border-red-500 flex items-center justify-center">
            <span className="text-red-500 text-xl">!</span>
          </div>
          <h1 className="text-lg font-display font-bold text-white mb-2 tracking-wider">
            ERROR
          </h1>
          <p className="text-[11px] text-p01-chrome/60 text-center font-mono mb-4">
            Something went wrong.
          </p>
          <div className="w-full bg-p01-surface border border-p01-border p-3 mb-4 max-h-32 overflow-auto">
            <p className="text-[10px] text-red-400 font-mono break-all">
              {this.state.error?.message || 'Unknown error'}
            </p>
          </div>
          <button
            onClick={this.handleReset}
            className="px-4 py-2 bg-p01-cyan text-p01-void font-display font-bold text-sm tracking-wider hover:bg-p01-cyan-dim transition-colors"
          >
            RESET & RELOAD
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
