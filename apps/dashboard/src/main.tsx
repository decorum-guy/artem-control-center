import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessProvider } from "./AccessControls";
import { ActionConfirmationProvider } from "./ActionConfirmations";
import { AvalarActionsProvider } from "./AvalarActions";
import { ConnectivityActionsProvider } from "./ConnectivityActions";
import { WeatherProvider } from "./Weather";
import { App } from "./App";
import "./ActionConfirmations.css";
import "./AvalarActions.css";
import "./ConnectivityActions.css";
import "./Weather.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActionConfirmationProvider>
      <AccessProvider>
        <WeatherProvider>
          <ConnectivityActionsProvider>
            <AvalarActionsProvider>
              <App />
            </AvalarActionsProvider>
          </ConnectivityActionsProvider>
        </WeatherProvider>
      </AccessProvider>
    </ActionConfirmationProvider>
  </StrictMode>
);
