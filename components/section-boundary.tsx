"use client";
import { Component, type ReactNode } from "react";
export class SectionBoundary extends Component<
  { children: ReactNode; name: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <section className="card padded form-stack" role="alert">
        <h2>{this.props.name} is temporarily unavailable</h2>
        <p>Your records are safe. Try loading this section again.</p>
        <button
          className="button secondary"
          onClick={() => this.setState({ failed: false })}
        >
          Try Again
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}
