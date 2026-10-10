import { createRoot } from "react-dom/client";
import "./styles.css";
import "./login.css";
import { App } from "./App";
import { SiteDialog } from "./SiteDialog";
import { SiteFeedback } from "./SiteFeedback";
import { ModalScrollLock } from "./ModalScrollLock";
createRoot(document.getElementById("root")!).render(<><App /><SiteDialog /><SiteFeedback /><ModalScrollLock /></>);
