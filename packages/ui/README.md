# @p01/ui

Protocol 01 design system. Ultra dark theme with neon accents, supporting both React (web) and React Native (mobile). Provides design tokens, pre-built components, and a unified theme object.

## Installation

```bash
npm install @p01/ui
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
  Toast,
  useToast,
  Loader,
} from '@p01/ui';

function PaymentForm() {
  const { showToast } = useToast();

  return (
    <Card glow="green">
      <CardHeader>Send Payment</CardHeader>
      <CardBody>
        <Input placeholder="Recipient address" size="md" />
        <Input placeholder="Amount" size="md" />
        <Button
          variant="primary"
          onClick={() => showToast({ message: 'Payment sent!' })}
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
import { colors, spacing, fontSizes, glows, shadows } from '@p01/ui';

const styles = {
  container: {
    backgroundColor: colors.bg.primary,
    padding: spacing[4],
    borderRadius: '8px',
    boxShadow: shadows.md,
  },
  heading: {
    color: colors.text.primary,
    fontSize: fontSizes.xl,
  },
  accentBox: {
    boxShadow: glows.green,
  },
};
```

### Using the Theme Object

```tsx
import { theme } from '@p01/ui';
import type { Theme } from '@p01/ui';

// Use with styled-components, Emotion, or any theme provider
<ThemeProvider theme={theme}>
  <App />
</ThemeProvider>

// Access any token through the theme
theme.colors.neon.green;
theme.spacing[4];
theme.fontSizes.lg;
theme.shadows.xl;
theme.durations.normal;
```

## API Reference

### Components

| Component | Description |
|---|---|
| `Button` | Primary, secondary, ghost, and danger button variants |
| `Card`, `CardHeader`, `CardBody`, `CardFooter` | Card container with optional glow effect |
| `Input`, `TextArea` | Text input fields with size and variant options |
| `Badge`, `StatusBadge`, `ModuleBadge` | Labels for status, categories, and module indicators |
| `Avatar`, `AvatarGroup` | User avatars with glow and grouping support |
| `Modal`, `ConfirmModal` | Dialog overlays with size options |
| `Toast`, `ToastContainer`, `useToast` | Toast notifications with position and variant control |
| `Loader`, `FullPageLoader`, `Skeleton` | Loading indicators and skeleton placeholders |

### Design Tokens -- Colors

```typescript
import { colors, getModuleColor, getStatusColor } from '@p01/ui';

colors.bg.primary;      // Background colors
colors.text.primary;     // Text colors
colors.neon.green;       // Neon accent colors
getModuleColor('wallet'); // Module-specific colors
getStatusColor('success'); // Status-specific colors
```

### Design Tokens -- Typography

```typescript
import { fontFamilies, fontSizes, fontWeights, lineHeights, letterSpacings, textStyles } from '@p01/ui';
```

### Design Tokens -- Spacing and Layout

```typescript
import { spacing, semanticSpacing, radii, borderWidths, zIndices, breakpoints, mediaQueries, sizes } from '@p01/ui';
```

### Design Tokens -- Shadows and Glows

```typescript
import { shadows, glows, textGlows, borderGlows, glass, getModuleGlow, getStatusGlow } from '@p01/ui';
```

### Design Tokens -- Animations

```typescript
import { durations, easings, keyframes, animations, transitions, rnAnimationConfig } from '@p01/ui';
```

### Theme Object

The `theme` export combines all tokens into a single object for use with theme providers:

```typescript
import { theme } from '@p01/ui';

// theme.colors, theme.fonts, theme.fontSizes, theme.fontWeights,
// theme.lineHeights, theme.letterSpacings, theme.spacing, theme.radii,
// theme.borderWidths, theme.zIndices, theme.breakpoints, theme.sizes,
// theme.shadows, theme.glows, theme.glass, theme.durations,
// theme.easings, theme.transitions
```

### Sub-path Imports

```typescript
import { colors } from '@p01/ui/colors';
import { fontSizes, textStyles } from '@p01/ui/typography';
import { spacing, breakpoints } from '@p01/ui/spacing';
import { animations, keyframes } from '@p01/ui/animations';
```

## License

MIT
