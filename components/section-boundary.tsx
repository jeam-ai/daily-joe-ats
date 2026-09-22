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
        <h2>{this.props.name} could not be loaded yet</h2>
        <p>
          The latest saved information for this section is not available right
          now. No records were changed.
        </p>
        <button
          className="button secondary"
          onClick={() => this.setState({ failed: false })}
        >
          Load section again
        </button>
      </section>
    ) : (
      this.props.children
    );
  }
}
