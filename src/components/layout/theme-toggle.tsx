"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { THEME_STORAGE_KEY as KEY } from "./theme-script";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={dark ? "Mudar para tema claro" : "Mudar para tema escuro"}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
