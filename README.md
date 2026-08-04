<div align="center">

<img src="assets/images/IMG20260403160453.jpg" alt="AswinPrints Banner" width="100%" style="border-radius:12px;max-height:320px;object-fit:cover;" />

<br /><br />

# 🖨️ AswinPrints

### Your Ideas, Printed in 3D — Pondicherry, India

[![Live Site](https://img.shields.io/badge/🌐_Live_Site-3d--prints.aswincloud.com-ff6b00?style=for-the-badge)](https://3d-prints.aswincloud.com/)
[![Deploy](https://img.shields.io/github/actions/workflow/status/Aswincloud/3d_printing/deploy.yml?style=for-the-badge&label=Deploy&color=22c55e)](https://github.com/Aswincloud/3d_printing/actions/workflows/deploy.yml)
[![Printer](https://img.shields.io/badge/Printer-Bambu_Lab_A1-ff6b00?style=for-the-badge)](https://bambulab.com)
[![Instagram](https://img.shields.io/badge/📸_@3dprinthub.offl-E4405F?style=for-the-badge)](https://www.instagram.com/3dprinthub.offl)
[![Location](https://img.shields.io/badge/📍_Location-Pondicherry,_India-3b82f6?style=for-the-badge)](#)

</div>

---

## ✨ About

**AswinPrints** is a custom 3D printing business run by [Aswin Zayasankaran](https://www.aswincloud.com), based in Pondicherry, India. Powered by the **Bambu Lab A1**, I print everything from intricate figurines and decorative pieces to functional prototypes and personalised gifts.

> 🎯 **Goal**: Make 3D printing accessible to everyone — fast turnaround, fair pricing, quality you can see.

---

## 🎨 Sample Prints

<div align="center">

| | | |
|---|---|---|
| <img src="assets/images/IMG20260725_toothless_collection.jpg" width="220" /> | <img src="assets/images/IMG20260531_laughing_buddha.jpg" width="220" /> | <img src="assets/images/IMG20260725_robot_articulated.jpg" width="220" /> |
| <img src="assets/images/IMG20260725_elephant.jpg" width="220" /> | <img src="assets/images/IMG20260521_vases_temple.jpg" width="220" /> | <img src="assets/images/IMG20260725_dahlias.jpg" width="220" /> |

*[View full gallery →](https://3d-prints.aswincloud.com/#gallery)*

</div>

---

## 🛠️ Services

| Service | Description |
|---|---|
| 🎨 **Custom Figurines** | Characters, mascots, collectibles printed with fine detail |
| ⚙️ **Functional Parts** | Replacement components, brackets, mechanical parts |
| 🏠 **Home Décor** | Vases, wall art, organizers, decorative accents |
| 🎁 **Personalised Gifts** | Name plates, keychains, one-of-a-kind custom pieces |
| 🔬 **Prototypes** | Rapid prototyping for product ideas and engineering models |
| 📦 **Small Batch Runs** | Multiple copies with consistent quality |

---

## 📐 How It Works

| Step | What Happens |
|---|---|
| **1 · Send Your Request** | Fill in the [quote form](https://3d-prints.aswincloud.com/#quote) with your idea. Attach an `STL`, `OBJ`, or `3MF` file if you have one — otherwise just describe it. |
| **2 · Get a Quote** | I review the model, materials and quantity, then reply with pricing. Usually within a few hours. |
| **3 · Print & Review** | Once approved, your piece goes on the printer. I share photos before it ships. |
| **4 · Deliver** | Pickup in Pondicherry, or shipping anywhere in India. |

---

## ⚙️ Tech Stack

| | Tool |
|---|---|
| **Printer** | Bambu Lab A1 |
| **Materials** | PLA · PETG · TPU — with custom colour matching |
| **File Formats** | STL · OBJ · 3MF |
| **Website** | Pure HTML / CSS / JS — no build tools, no dependencies |
| **Hosting** | GitHub Pages (custom domain via `CNAME`) |
| **CI/CD** | GitHub Actions (auto-deploy on push to `main`) |
| **Quote Emails** | GitHub Actions + [Resend](https://resend.com) |

---

## 🚀 How the Site Works

The website is a static single-page app — no frameworks, no dependencies.

```
3d_printing/
├── index.html                   # Main website (all sections)
├── CNAME                        # Custom domain: 3d-prints.aswincloud.com
├── assets/
│   ├── css/style.css            # All styling
│   ├── js/main.js               # Lightbox, animations, quote form
│   └── images/                  # 60 sample print photos
└── .github/
    └── workflows/
        ├── deploy.yml           # Auto-deploy to GitHub Pages
        ├── send-quote.yml       # Emails quote requests via Resend
        └── auto-approve.yml     # Dependabot auto-approval
```

Every push to `main` triggers the deploy workflow, which publishes to:

> **https://3d-prints.aswincloud.com/**

### Quote form pipeline

The quote form has no backend. Submitting it fires a `repository_dispatch` event of
type `quote_request` at this repo, which triggers `send-quote.yml`. That workflow sends
two emails through Resend:

1. **To me** — the full request, with a download link for any attached model file.
2. **To the customer** — an acknowledgement with a summary of what they submitted.

The dispatch token is injected into `main.js` at deploy time from the
`DISPATCH_TOKEN` secret, so it never lives in the repo.

---

## 📬 Get a Quote

Want something printed? Head to the [quote form](https://3d-prints.aswincloud.com/#quote) on the site, or reach out directly:

- 🌐 [aswincloud.com](https://www.aswincloud.com)
- 📧 aswin@aswincloud.com
- 📸 [@3dprinthub.offl](https://www.instagram.com/3dprinthub.offl)
- 📍 Pondicherry, India

---

## 📄 License

© 2026 Aswin Zayasankaran. All rights reserved.
