import { useEffect } from "react";
import { showNotice } from "./SiteDialog";

export function SiteFeedback() {
  useEffect(() => {
    let showingValidation = false;
    const invalid = (event: Event) => {
      event.preventDefault();
      if (showingValidation) return;
      const input = event.target as HTMLInputElement;
      showingValidation = true;
      void showNotice(input.validationMessage || "Lütfen bu alanı kontrol edin.", { title: "Bilgileri Kontrol Edin" }).then(() => {
        showingValidation = false;
        if (input.isConnected) input.focus();
      });
    };
    document.addEventListener("invalid", invalid, true);
    return () => {
      document.removeEventListener("invalid", invalid, true);
    };
  }, []);
  return null;
}
