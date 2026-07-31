import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessProvider } from "./AccessControls";
import { AvalarActionsProvider } from "./AvalarActions";
import { App } from "./App";
import "./AvalarActions.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccessProvider>
      <AvalarActionsProvider>
        <App />
      </AvalarActionsProvider>
    </AccessProvider>
  </StrictMode>
);
