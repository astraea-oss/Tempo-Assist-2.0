import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17211c",
        moss: "#2f5d50",
        amber: "#efb84f",
        clay: "#c86f4f",
        mist: "#f4f1ea",
        paper: "#fffaf0",
      },
      boxShadow: {
        soft: "0 18px 60px rgba(23, 33, 28, 0.12)",
      },
    },
  },
  plugins: [require("@tailwindcss/forms")],
} satisfies Config;
