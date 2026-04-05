# @protocol-01/ui

Protocol 01 design system and component library. Ultra-dark cyberpunk theme with cyan/pink neon accents, inspired by Hatsune Miku, NEEDY STREAMER OVERLOAD, and ULTRAKILL.

Supports both React (web) and React Native (mobile). Provides design tokens, pre-built components, and a unified theme object.

## Install

```bash
npm install @protocol-01/ui
```

Peer dependencies: `react >= 18.0.0`. React Native (`react-native >= 0.72.0`) is optional.

## Quick Start

### Using Components

```tsx
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Input,
  Badge,
  Modal,
  useToast,
} from '@protocol-01/ui';

function PaymentForm() {
  const { success } = useToast();

  return (
    <Card glow="green">
      <CardHeader title="Send Payment" subtitle="Transfer SOL privately" />
      <CardBody>
        <Input placeholder="Recipient address" size="md" />
        <Input placeholder="Amount" size="md" />
        <Button
          variant="primary"
          onClick={() => success('Payment sent!')}
        >
          Send
        </Button>
        <Badge variant="success">Connected</Badge>
      </CardBody>
    </Card>
  );
}
```

### Using Design Tokens

```tsx
import { colors, spacing, fontSizes, glows, shadows } from '@protocol-01/ui';

const styles = {
  container: {
    backgroundColor: colors.void,
    padding: spacing[4],
    borderRadius: '8px',
    boxShadow: shadows.md,
  },
  heading: {
    color: colors.text,
    fontSize: fontSizes.xl,
  },
  accentBox: {
    boxShadow: glows.green,
  },
};
```

### Using the Theme Object

```tsx
import { theme } from '@protocol-01/ui';
import type { Theme } from '@protocol-01/ui';

// Use with styled-components, Emotion, or any theme provider
<ThemeProvider theme={theme}>
  <App />
</ThemeProvider>

// Access any token through the theme
theme.colors.cyan;        // '#39c5bb'
theme.spacing[4];         // 16
theme.fontSizes.lg;       // 18
theme.shadows.xl;         // '0 12px 24px rgba(0, 0, 0, 0.7)'
theme.durations.normal;   // 200
```

### Theme Customization

Use `createTheme()` to deep-merge your overrides with the default theme:

```tsx
import { createTheme, theme } from '@protocol-01/ui';

const customTheme = createTheme({
  colors: {
    cyan: '#00ffcc',
    pink: '#ff00aa',
  },
});

// customTheme has all default tokens with your overrides applied
<ThemeProvider theme={customTheme}>
  <App />
</ThemeProvider>
```

## Design Tokens

### Colors

The color system is cyberpunk-inspired with cyan as primary and pink as secondary. No purple, no black text.

#### Backgrounds (deep dark layers)

| Token | Value | Usage |
|-------|-------|-------|
| `colors.void` | `#0a0a0c` | Deepest background |
| `colors.dark` | `#0f0f12` | Page background |
| `colors.surface` | `#151518` | Card backgrounds |
| `colors.surface2` | `#1a1a1e` | Elevated surfaces |
| `colors.surface3` | `#25252b` | Hover states |
| `colors.elevated` | `#1f1f24` | Elevated containers |

#### Primary -- Cyan (Miku-inspired)

| Token | Value | Usage |
|-------|-------|-------|
| `colors.cyan` | `#39c5bb` | Primary brand color |
| `colors.cyanDim` | `#2a9d95` | Hover/pressed states |
| `colors.cyanBright` | `#00ffe5` | Highlights, accents |
| `colors.cyanGlow` | `rgba(57,197,187,0.15)` | Subtle glow backgrounds |

#### Secondary -- Pink (KAngel-inspired)

| Token | Value | Usage |
|-------|-------|-------|
| `colors.pink` | `#ff77a8` | Secondary brand color |
| `colors.pinkHot` | `#ff2d7a` | Hot/urgent accents |
| `colors.pinkLight` | `#ff9dc4` | Soft accents |

#### Status Colors

| Token | Value | Usage |
|-------|-------|-------|
| `colors.success` | `#39c5bb` | Success states (cyan, NOT green) |
| `colors.error` | `#ff3366` | Error states |
| `colors.warning` | `#ffcc00` | Warning states |
| `colors.info` | `#39c5bb` | Info states |

#### Module Colors

| Token | Value | Module |
|-------|-------|--------|
| `colors.wallet` | `#39c5bb` | Wallet (cyan) |
| `colors.streams` | `#ff77a8` | Streams (pink) |
| `colors.social` | `#00ffe5` | Social (bright cyan) |
| `colors.agent` | `#ffcc00` | Agent (yellow) |

#### Text Colors

| Token | Value | Usage |
|-------|-------|-------|
| `colors.text` | `#ffffff` | Primary text |
| `colors.textSecondary` | `#888892` | Secondary text |
| `colors.textMuted` | `#555560` | Muted/disabled text |
| `colors.textDisabled` | `#3a3a40` | Disabled text |

### Typography

| Token | Value | Usage |
|-------|-------|-------|
| `fontFamilies.sans` | System sans-serif stack | UI text |
| `fontFamilies.mono` | SF Mono / Fira Code stack | Code, addresses, numbers |
| `fontFamilies.display` | Inter / system stack | Headings |

#### Font Sizes (modular 1.25 scale)

| Token | Value |
|-------|-------|
| `fontSizes.xs` | 10px |
| `fontSizes.sm` | 12px |
| `fontSizes.base` | 14px |
| `fontSizes.md` | 16px |
| `fontSizes.lg` | 18px |
| `fontSizes.xl` | 20px |
| `fontSizes['2xl']` | 24px |
| `fontSizes['3xl']` | 30px |
| `fontSizes['4xl']` | 36px |

#### Font Weights

| Token | Value |
|-------|-------|
| `fontWeights.normal` | 400 |
| `fontWeights.medium` | 500 |
| `fontWeights.semibold` | 600 |
| `fontWeights.bold` | 700 |

### Spacing (4px grid)

| Token | Value | Token | Value |
|-------|-------|-------|-------|
| `spacing[1]` | 4px | `spacing[6]` | 24px |
| `spacing[2]` | 8px | `spacing[8]` | 32px |
| `spacing[3]` | 12px | `spacing[10]` | 40px |
| `spacing[4]` | 16px | `spacing[12]` | 48px |
| `spacing[5]` | 20px | `spacing[16]` | 64px |

### Shadows and Glows

#### Elevation Shadows

| Token | Value |
|-------|-------|
| `shadows.sm` | `0 2px 4px rgba(0,0,0,0.5)` |
| `shadows.md` | `0 4px 8px rgba(0,0,0,0.6)` |
| `shadows.lg` | `0 8px 16px rgba(0,0,0,0.6)` |
| `shadows.xl` | `0 12px 24px rgba(0,0,0,0.7)` |

#### Neon Glows

| Token | Effect |
|-------|--------|
| `glows.green` / `glows.greenSm` | Cyan glow (primary) |
| `glows.purple` / `glows.purpleSm` | Pink glow (streams) |
| `glows.blue` / `glows.blueSm` | Bright cyan glow (social) |
| `glows.amber` / `glows.amberSm` | Yellow glow (agent) |
| `glows.red` / `glows.redSm` | Red glow (error) |

#### Text Glows

```ts
import { textGlows } from '@protocol-01/ui';
// textGlows.green, textGlows.purple, textGlows.blue, textGlows.amber, textGlows.red
```

#### Glass Effects

```ts
import { glass } from '@protocol-01/ui';
// glass.card      — Standard glass card (blur 12px)
// glass.cardElevated — Elevated glass (blur 16px)
// glass.cardSubtle   — Subtle glass (blur 8px)
// glass.modal        — Modal glass (blur 20px)
// glass.header       — Header/footer glass (blur 12px)
```

## Components

### Button

Interactive button with neon glow effects and loading state.

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'primary' \| 'secondary' \| 'ghost' \| 'danger'` | `'primary'` | Visual style |
| `size` | `'sm' \| 'md' \| 'lg' \| 'xl'` | `'md'` | Button size |
| `isLoading` | `boolean` | `false` | Show loading spinner |
| `isFullWidth` | `boolean` | `false` | Stretch to 100% width |
| `leftIcon` | `ReactNode` | - | Icon before text |
| `rightIcon` | `ReactNode` | - | Icon after text |
| `disabled` | `boolean` | `false` | Disable interaction |

```tsx
<Button variant="primary" size="lg" isLoading={isPending}>
  Shield SOL
</Button>
<Button variant="secondary" leftIcon={<WalletIcon />}>Connect</Button>
<Button variant="danger" size="sm">Disconnect</Button>
```

### Card / CardHeader / CardBody / CardFooter

Glass-morphism card container with optional glow border.

**Card Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'default' \| 'elevated' \| 'subtle' \| 'outlined' \| 'ghost'` | `'default'` | Glass style |
| `glow` | `'none' \| 'green' \| 'purple' \| 'blue' \| 'amber'` | `'none'` | Neon glow color |
| `padding` | `'none' \| 'sm' \| 'md' \| 'lg' \| 'xl'` | `'md'` | Internal padding |
| `isHoverable` | `boolean` | `false` | Lift on hover |
| `isPressable` | `boolean` | `false` | Scale on press + pointer cursor |
| `isDisabled` | `boolean` | `false` | Dim and disable interaction |

**CardHeader Props:** `title`, `subtitle`, `action`, or custom `children`.

```tsx
<Card variant="elevated" glow="green" isHoverable>
  <CardHeader title="Privacy Pool" subtitle="0.1 SOL denomination" />
  <CardBody>
    <p>Pool balance: 42.5 SOL</p>
  </CardBody>
  <CardFooter>
    <Button variant="secondary">Details</Button>
    <Button variant="primary">Shield</Button>
  </CardFooter>
</Card>
```

### Input / TextArea

Dark-themed text input with glow focus effects.

**Input Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Input height |
| `variant` | `'default' \| 'filled' \| 'ghost'` | `'default'` | Visual style |
| `label` | `string` | - | Label above input |
| `hint` | `string` | - | Helper text below |
| `error` | `string` | - | Error text (turns border red) |
| `leftIcon` | `ReactNode` | - | Icon inside left |
| `rightIcon` | `ReactNode` | - | Icon inside right |
| `leftAddon` | `ReactNode` | - | Addon before input |
| `rightAddon` | `ReactNode` | - | Addon after input |
| `isFullWidth` | `boolean` | `false` | Stretch to 100% width |

**TextArea Props:** `label`, `hint`, `error`, `isFullWidth`, `resize`.

```tsx
<Input
  label="Recipient"
  placeholder="Enter Solana address"
  size="md"
  error={addressError}
  isFullWidth
/>
<TextArea label="Note" hint="Optional encrypted memo" resize="vertical" />
```

### Badge / StatusBadge / ModuleBadge

Labels for status indicators, categories, and module identification.

**Badge Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `variant` | `'solid' \| 'subtle' \| 'outline' \| 'glow'` | `'subtle'` | Visual style |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Badge size |
| `color` | `'green' \| 'purple' \| 'blue' \| 'amber' \| 'red' \| 'gray'` | `'green'` | Accent color |

**StatusBadge:** Pre-configured for status types (`success`, `error`, `warning`, `info`, `pending`, `offline`) with colored dot.

**ModuleBadge:** Pre-configured for Protocol 01 modules (`wallet`, `streams`, `social`, `agent`).

```tsx
<Badge variant="glow" color="green">Shielded</Badge>
<StatusBadge status="success" />
<ModuleBadge module="streams" />
```

### Avatar / AvatarGroup

User avatars with glow effects, online status, and fallback initials.

**Avatar Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `src` | `string` | - | Image URL |
| `name` | `string` | - | Name for initials fallback |
| `size` | `'xs' \| 'sm' \| 'md' \| 'lg' \| 'xl' \| '2xl'` | `'md'` | Avatar size |
| `variant` | `'circle' \| 'rounded' \| 'square'` | `'circle'` | Shape |
| `glow` | `'none' \| 'green' \| 'purple' \| 'blue' \| 'amber'` | `'none'` | Neon border glow |
| `isOnline` | `boolean` | - | Show online/offline dot |
| `isBordered` | `boolean` | `false` | Show border |
| `fallback` | `ReactNode` | - | Custom fallback content |

**AvatarGroup Props:** `max` (default 4), `size`, `children`.

```tsx
<Avatar name="Satoshi" size="lg" glow="green" isOnline />
<AvatarGroup max={3}>
  <Avatar name="Alice" src="/alice.png" />
  <Avatar name="Bob" src="/bob.png" />
  <Avatar name="Carol" />
</AvatarGroup>
```

### Modal / ConfirmModal

Dialog overlays with glass morphism, animations, and keyboard support (Escape to close).

**Modal Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `isOpen` | `boolean` | required | Control visibility |
| `onClose` | `() => void` | required | Close callback |
| `title` | `string` | - | Header title |
| `subtitle` | `string` | - | Header subtitle |
| `size` | `'sm' \| 'md' \| 'lg' \| 'xl' \| 'full'` | `'md'` | Width preset |
| `closeOnOverlayClick` | `boolean` | `true` | Close on backdrop click |
| `closeOnEscape` | `boolean` | `true` | Close on Escape key |
| `showCloseButton` | `boolean` | `true` | Show X button |
| `header` | `ReactNode` | - | Custom header content |
| `footer` | `ReactNode` | - | Footer content (e.g. action buttons) |

**ConfirmModal Props:** `isOpen`, `onClose`, `onConfirm`, `title`, `message`, `confirmText`, `cancelText`, `variant` (`'default' | 'danger'`), `isLoading`.

```tsx
<Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Shield SOL">
  <p>You are about to shield 1.0 SOL into the 1.0 pool.</p>
</Modal>

<ConfirmModal
  isOpen={showConfirm}
  onClose={() => setShowConfirm(false)}
  onConfirm={handleUnshield}
  title="Confirm Unshield"
  message="This will reveal 1.0 SOL to your public address."
  variant="danger"
  confirmText="Unshield"
/>
```

### Toast / ToastContainer / useToast()

Notification toasts with variant-colored accents and auto-dismiss.

**useToast() Hook:**

```tsx
const { toasts, addToast, removeToast, success, error, warning, info } = useToast();

// Shorthand methods
success('Transaction confirmed!');
error('Proof generation failed', 'ZK Error');
warning('Low SOL balance');
info('Scanning for stealth payments...');

// Full control
addToast({
  message: 'Shielded 1.0 SOL',
  variant: 'success',
  duration: 3000,
  action: { label: 'View TX', onClick: () => openExplorer(txId) },
});
```

**ToastContainer Props:** `position` (`'top-right' | 'top-left' | 'top-center' | 'bottom-right' | 'bottom-left' | 'bottom-center'`).

```tsx
<ToastContainer position="top-right">
  {toasts.map((t) => (
    <Toast key={t.id} {...t} onClose={removeToast} />
  ))}
</ToastContainer>
```

### Loader / FullPageLoader / Skeleton

Loading indicators with ghost-themed animations.

**Loader Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `size` | `'xs' \| 'sm' \| 'md' \| 'lg' \| 'xl'` | `'md'` | Loader size |
| `variant` | `'spinner' \| 'ghost' \| 'dots' \| 'pulse' \| 'typing'` | `'ghost'` | Animation style |
| `color` | `'green' \| 'purple' \| 'blue' \| 'amber' \| 'white'` | `'green'` | Accent color |
| `label` | `string` | - | Text below loader |

**FullPageLoader Props:** `isVisible`, `label` (default `'Loading...'`).

**Skeleton Props:** `width`, `height`, `borderRadius`, `isCircle`.

```tsx
<Loader variant="ghost" size="lg" color="green" label="Generating proof..." />
<FullPageLoader isVisible={isLoading} label="Initializing ZK prover..." />
<Skeleton width="100%" height={20} />
<Skeleton isCircle height={40} />
```

## Platform Support

All components are currently implemented as web (React DOM) components using inline styles. They work with any React web framework (Next.js, Vite, etc.).

| Component | React (Web) | React Native |
|-----------|:----------:|:------------:|
| Button | Yes | Planned |
| Card / CardHeader / CardBody / CardFooter | Yes | Planned |
| Input / TextArea | Yes | Planned |
| Badge / StatusBadge / ModuleBadge | Yes | Planned |
| Avatar / AvatarGroup | Yes | Planned |
| Modal / ConfirmModal | Yes | Planned |
| Toast / ToastContainer / useToast | Yes | Planned |
| Loader / FullPageLoader / Skeleton | Yes | Planned |
| Design tokens (colors, spacing, etc.) | Yes | Yes |
| Theme object | Yes | Yes |
| Animation configs (`rnAnimationConfig`) | N/A | Yes |

Design tokens and the theme object work on both platforms. The `rnAnimationConfig` export provides React Native Reanimated spring/timing configs.

## Sub-path Imports

Import only what you need for tree-shaking and smaller bundles:

```typescript
import { colors, getModuleColor, getStatusColor } from '@protocol-01/ui/colors';
import { fontSizes, textStyles, fontFamilies } from '@protocol-01/ui/typography';
import { spacing, breakpoints, radii, sizes } from '@protocol-01/ui/spacing';
import { animations, keyframes, rnAnimationConfig } from '@protocol-01/ui/animations';
```

## License

MIT
