# Accessibility (Step 67)

The target is **WCAG 2.2 level AA** for the public pages, the apply journey and the candidate account. The public statement is at `/accessibility`.

This page lists what is in place, what the automated tests check, and the manual checks that still have to be done. Hireriv does **not** claim to be fully conformant until those manual checks are done and recorded here.

## 1. In place

- **Language**:
  - every page has `<html lang>`
  - text in another language carries its own `lang`, for example language names in the selector and the English original of a translated job
  - workspace pages not yet translated are marked `lang="en"`
- **Structure**:
  - a skip link to `<main>`
  - one `h1` per page and headings in order (footer headings are now `h2`)
  - landmarks for the header, navigation, main and footer
- **Keyboard**:
  - everything works by keyboard, and nothing uses a positive `tabindex`
  - visible focus (3px outline)
  - the mobile menu says whether it opens or closes, and Escape closes it (and the Login list) and returns focus to the button
  - the industry tabs follow the tab pattern: arrow keys, Home and End, and only the chosen tab in the Tab order
  - `scroll-padding-top` stops the sticky header from covering a focused field
- **Forms**:
  - every field has a label
  - errors appear at the top of the form, are announced (`role="alert"`), link to their field, mark it `aria-invalid` and stay there until the form is sent again
  - the apply form shows everything for checking before it is sent
  - what was typed survives a reload
  - nothing has a time limit
- **Names**:
  - icon-only buttons have `aria-label`, and decorative icons are `aria-hidden`
  - status pills always carry words, so no status relies on colour alone
- **Dialogs**: the voice permission prompt uses the native `<dialog>`. Focus moves into it, Escape cancels and focus returns.
- **Motion**:
  - `prefers-reduced-motion` turns off animations, reveal effects and smooth scrolling
  - no flashing content
- **Text size and reflow**:
  - rem-based sizes, so pages work at 200% zoom and at 320px wide (`test/mobile.test.js` checks tables scroll inside their own box)
  - Hindi and Telugu get extra line height
- **Targets**: controls are at least 24×24px (WCAG 2.5.8), and most are 44px on phones.
- **Forced colours** (Windows high contrast): focus, the current language, pressed buttons and invalid fields keep a visible outline.
- **Contrast**: body text (#45556E on white) is about 7.5:1, muted text (#5E6D85) about 5.3:1 on white and 4.8:1 on the light grey panels, and buttons have white on #1F6BC2 at about 5.3:1.
- **Media**: Hireriv has no video or audio content of its own. Read-aloud is the browser's voice reading text already on the page, so captions are not needed. Any video added later needs captions.
- **Alternatives**: voice input and read-aloud are optional. Typing and reading always work, and the buttons appear only where the browser supports them.

## 2. Automated checks

`test/accessibility.test.js` renders the public pages in English and Hindi, and the candidate pages. It fails on:

- no `lang`
- not exactly one `h1`
- no `main` or skip link
- a positive `tabindex`
- an image without `alt`
- a form field without a label
- a button or link without a name
- an empty status pill

`test/i18n.test.js` checks the language selector, Hindi pages end to end, and localised errors with field names. `test/mobile.test.js` checks the phone layout.

These catch only what a machine can see. They are not a conformance test.

## 3. Manual checks still to do (not done yet)

Record the date, the person, the browser and the assistive technology for each.

- [ ] Keyboard only: find a job, filter, save it, apply (with and without a resume), sign in, change the language, sign out. Check that focus is never lost or hidden.
- [ ] NVDA with Firefox on Windows, and TalkBack with Chrome on Android, in English and Hindi. Check that Hindi is read with a Hindi voice and that errors are announced.
- [ ] VoiceOver on iPhone (Safari): the apply form, the check step and the error summary.
- [ ] 200% browser zoom and 400% reflow at 1280px. Check that nothing is cut off and nothing scrolls sideways except tables.
- [ ] Windows high contrast mode on the home page, jobs, the job page and the apply form.
- [ ] Contrast of every status pill and chip, measured with a contrast checker.
- [ ] Speech input with Chrome on Android in Hindi and Telugu, and read-aloud in Hindi.
- [ ] Employer workspace and Admin pages: these were not reviewed in this step and are English only.

## 4. Known gaps

- The employer workspace, the Admin pages and emails are English only, and their accessibility has not been reviewed beyond the shared header, footer and forms.
- Charts on the reports pages have tables, but no review against the non-text-contrast rule has been done.
- Date fields use the browser's own date picker, which varies by browser. The accessible alternative is typing the date.
