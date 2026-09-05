# PulseBill Enterprise Design System Specification

This document defines the single source of truth (SSOT) for the UI/UX architecture, visual identity, typography, component hierarchy, and responsive layout standards for the PulseBill Telecom Billing & Automation Platform.

---

## 1. Brand Identity & Color Palette

### 1.1 Core Colors
* **Canvas Background:** `#F8FAFC` (Clean Slate 50)
* **Card Surface:** `#FFFFFF` (Pure White)
* **Card Border:** `#E2E8F0` / `#E2EBF4` (Subtle 1px border)
* **Brand Primary Navy:** `#152C4A` (Deep Enterprise Navy)
* **Brand Accent Emerald:** `#10B981` / `#059669` (Fintech Payment & Settled Green)
* **Brand Action Blue:** `#2563EB` (Solid Royal Action Blue)
* **Hero Banner Gradient:** `linear-gradient(135deg, #F1F7FC 0%, #FFFFFF 100%)`
* **Signature Brand Gradient:** `linear-gradient(135deg, #152C4A 0%, #059669 100%)`
  * Applied consistently to: **Active Navigation Items**, **Primary Action Buttons (`+ Create Invoice`)**, and **System Avatar Boxes**.

### 1.2 Status & Transaction Palette
* **Paid / Settled / Active:** `bg-emerald-50 text-emerald-700 border-emerald-200`
* **Pending / Processing / Grace Period:** `bg-amber-50 text-amber-700 border-amber-200`
* **Suspended / Isolated / Overdue:** `bg-rose-50 text-rose-700 border-rose-200`
* **Refunded / Archived:** `bg-slate-100 text-slate-700 border-slate-300`

---

## 2. Typography System (Meta Enterprise Standards)

PulseBill adopts Meta's enterprise product design system typography standards (Astryx & Meta Business Suite specification), prioritizing optical clarity, high x-height, and semantic type tokens.

### 2.1 Font Family Stacks
* **Primary Interface Stack (Meta System Sans):**
  `"Optimistic Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`
* **Headline & Display Stack:**
  `"Optimistic Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`
* **Technical & Financial Monospace Stack:**
  `"SF Mono", "JetBrains Mono", "Roboto Mono", Menlo, Consolas, monospace`
  *(Strictly utilized for: Invoice Numbers, Transaction Hashes, Currency Amounts, Mikrotik IP/MAC, and Bandwidth Speeds)*

### 2.2 Typographic Hierarchy & Scale (1.2 Geometric Scale)
* **Page Title (Display / H1):** `text-lg sm:text-xl font-bold text-[#152C4A] tracking-tight` (18px - 20px, Leading: 24px)
* **Card & Section Header (H2/H3):** `text-xs sm:text-sm font-semibold text-[#152C4A] tracking-normal` (13px - 14px, Leading: 18px)
* **Revenue & Metric Numbers:** `text-xl sm:text-2xl font-bold text-[#152C4A] tracking-tight` (22px - 24px, Tabular figures)
* **Body / Table Cells:** `text-xs font-normal sm:font-medium text-slate-700` (12px - 13px, Leading: 16px)
* **Meta Secondary Subtext & Timestamps:** `text-[11px] text-slate-500 font-normal` (11px, Leading: 14px)
* **Status Badges & Payment Chips:** `text-[10px] font-semibold tracking-wider uppercase` (10px)

### 2.3 Strict Typography Rules
1. **Zero Emojis Policy:** Absolute zero emojis in UI buttons, tables, cards, and system status to maintain a high-end corporate enterprise look. All visual cues use clean Lucide SVG icons.
2. **Tabular Numerics:** All currency figures, invoice calculations, and IP addresses use monospace tabular figures (`JetBrains Mono` / `SF Mono`) to prevent layout jitter on live WebSocket updates.
3. **No Faux Italics:** In accordance with Meta Horizon & Astryx guidelines, oblique/italic text is avoided in operational dashboards to preserve high-contrast readability.

---

## 3. High-Density Financial Tables
* Header: `bg-slate-50 text-slate-500 font-mono text-[10px] uppercase tracking-wider py-2.5 px-3.5 border-b border-slate-200`
* Cells: `py-2.5 px-3.5 text-xs text-slate-700 border-b border-slate-100`
* Hover state: `hover:bg-slate-50 transition`
