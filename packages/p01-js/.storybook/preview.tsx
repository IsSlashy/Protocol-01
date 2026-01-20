import type { Preview } from '@storybook/react-vite'
import React from 'react'

// P-01 Theme Colors
// Inspired by: Hatsune Miku (cyan), NEEDY STREAMER OVERLOAD (pink), ULTRAKILL (red)
// RULES: NO purple | NO black text | NO green #00ff88
const P01_THEME = {
  primaryColor: '#39c5bb',    // Cyan (Miku)
  secondaryColor: '#ff77a8',  // Pink (KAngel)
  backgroundColor: '#0a0a0c', // Void
  surfaceColor: '#151518',    // Surface
  textColor: '#ffffff',       // White text only
  mutedColor: '#888892',
  borderColor: '#2a2a30',
  successColor: '#39c5bb',    // Cyan for success (NOT green!)
  errorColor: '#ff3366',      // P-01 Red (ULTRAKILL)
  warningColor: '#ffcc00',    // Yellow
}

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'p01-void',
      values: [
        { name: 'p01-void', value: P01_THEME.backgroundColor },
        { name: 'p01-surface', value: P01_THEME.surfaceColor },
        { name: 'white', value: '#ffffff' },
      ],
    },
    layout: 'centered',
    a11y: {
      test: 'todo'
    },
  },
  decorators: [
    (Story) => (
      <div style={{
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: P01_THEME.textColor,
      }}>
        <Story />
      </div>
    ),
  ],
}

export default preview