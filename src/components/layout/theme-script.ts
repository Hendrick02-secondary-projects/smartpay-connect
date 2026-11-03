/** Inline script (dashboards only) applied before paint to avoid a theme flash. Plain module — safe to import from server components. */
export const THEME_STORAGE_KEY = "spc-theme";
export const themeInitScript = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'){document.documentElement.classList.add('dark')}}catch(e){}`;
