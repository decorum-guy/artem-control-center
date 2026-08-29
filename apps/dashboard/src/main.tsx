import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccessProvider } from "./AccessControls";
import { ActionConfirmationProvider } from "./ActionConfirmations";
import { AvalarActionsProvider } from "./AvalarActions";
import { ConnectivityActionsProvider } from "./ConnectivityActions";
import { WeatherProvider } from "./Weather";
import { WeatherAutoRefresh } from "./WeatherAutoRefresh";
import { App } from "./App";
import { CoffeeUploadPage } from "./CoffeeUploadPage";
import { NoticeCenterProvider } from "./NoticeCenter";
import { InteractionLockProvider } from "./InteractionLock";
import { CalendarDisplayPreferencesProvider } from "./CalendarDisplayPreferences";
import { KioskPresenceHeartbeat } from "./KioskPresenceHeartbeat";
import { InterfaceCopyProvider } from "./interfaceCopy";
import "./InteractionLock.css";
import "./ActionConfirmations.css";
import "./AvalarActions.css";
import "./ConnectivityActions.css";
import "./styles.css";
import "./planningRoutes.css";
import "./Weather.css";
import "./features/overview/overviewGrid.css";
import "./features/overview/overviewWidgets.css";
import "./features/operations/operations.css";
import "./features/home/homeV2.css";
import "./features/services/servicesV2.css";
import "./features/system/systemV2.css";

const publicCoffeeUpload = window.location.pathname === "/coffee-upload";

createRoot(document.getElementById("root")!).render(publicCoffeeUpload ? <CoffeeUploadPage /> : (
  <StrictMode>
    <KioskPresenceHeartbeat />
    <NoticeCenterProvider>
      <InteractionLockProvider>
        <CalendarDisplayPreferencesProvider>
          <AccessProvider>
            <ActionConfirmationProvider>
              <InterfaceCopyProvider>
                <WeatherProvider>
                  <WeatherAutoRefresh />
                  <ConnectivityActionsProvider>
                    <AvalarActionsProvider>
                      <App />
                    </AvalarActionsProvider>
                  </ConnectivityActionsProvider>
                </WeatherProvider>
              </InterfaceCopyProvider>
            </ActionConfirmationProvider>
          </AccessProvider>
        </CalendarDisplayPreferencesProvider>
      </InteractionLockProvider>
    </NoticeCenterProvider>
  </StrictMode>
));
