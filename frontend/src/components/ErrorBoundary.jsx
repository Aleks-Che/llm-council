import { Component } from 'react';

/**
 * Ловит ошибки рендера дочернего дерева, чтобы один битый диалог/блок
 * не ронял всё приложение (сайдбар остаётся на месте).
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="render-error">
          <strong>Не удалось отобразить этот блок.</strong>
          <div className="render-error-details">
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            className="render-error-retry"
            onClick={() => this.setState({ error: null })}
          >
            Попробовать снова
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
