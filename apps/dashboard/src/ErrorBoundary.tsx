import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  title: string;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Widget isolated", { error: error.message, stack: info.componentStack });
  }

  render() {
    if (this.state.failed) {
      return (
        <article className="widget widget--error">
          <p className="eyebrow">Изолированная ошибка</p>
          <h2>{this.props.title}</h2>
          <p>Остальная панель продолжает работать.</p>
        </article>
      );
    }
    return this.props.children;
  }
}

