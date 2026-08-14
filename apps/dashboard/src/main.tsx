import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessProvider } from "./AccessControls";
import { ActionConfirmationProvider } from "./ActionConfirmations";
import { AvalarActionsProvider } from "./AvalarActions";
import { ConnectivityActionsProvider } from "./ConnectivityActions";
import { WeatherProvider } from "./Weather";
import { WeatherAutoRefresh } from "./WeatherAutoRefresh";
import { App } from "./App";
import { NoticeCenterProvider } from "./NoticeCenter";
import "./ActionConfirmations.css";
import "./AvalarActions.css";
import "./ConnectivityActions.css";
import "./styles.css";
import "./planningRoutes.css";
import "./Weather.css";
import "./features/overview/overviewGrid.css";
import "./features/overview/overviewWidgets.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <NoticeCenterProvider>
      <ActionConfirmationProvider>
        <AccessProvider>
          <WeatherProvider>
            <WeatherAutoRefresh />
            <ConnectivityActionsProvider>
              <AvalarActionsProvider>
                <App />
              </AvalarActionsProvider>
            </ConnectivityActionsProvider>
          </WeatherProvider>
        </AccessProvider>
      </ActionConfirmationProvider>
    </NoticeCenterProvider>
  </StrictMode>
);
