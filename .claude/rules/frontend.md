# Frontend Development Rules

## Technology Stack

Required:

- Next.js
- TypeScript
- TailwindCSS
- React Query

---

## Design Principles

Follow:

- Mobile-first design
- Accessibility standards
- Responsive layouts

Support:

- Desktop
- Tablet
- Mobile

---

## Component Structure

components/
??? ui/
??? forms/
??? layout/
??? shared/

Pages must not exceed 300 lines.

---

## State Management

Use:

- React Query
- Context API

Avoid:

- prop drilling
- unnecessary global state

---

## UI Requirements

Every page must include:

- loading state
- empty state
- error state

---

## Forms

Use:

- React Hook Form
- Zod Validation

No uncontrolled forms.

---

## Performance

Use:

- lazy loading
- image optimization
- route prefetching

Avoid unnecessary re-renders.

---

## Styling

Use Tailwind only.

Do not use:

- inline styles
- custom CSS files unless necessary
