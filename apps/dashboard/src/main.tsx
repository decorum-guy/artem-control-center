import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessProvider } from "./AccessControls";
import { ActionConfirmationProvider } from "./ActionConfirmations";
import { AvalarActionsProvider } from "./AvalarActions";
import { App } from "./App";
import "./ActionConfirmations.css";
import "./AvalarActions.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActionConfirmationProvider>
      <AccessProvider>
        <AvalarActionsProvider>
          <App />
        </AvalarActionsProvider>
      </AccessProvider>
    </ActionConfirmationProvider>
  </StrictMode>
);
