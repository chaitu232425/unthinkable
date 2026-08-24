/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Cool slate neutrals with a peacock-blue accent. The seat-status triad is
        // deliberately separate from the accent so a SELECTED seat can never be
        // confused with an AVAILABLE one.
        ink: {
          50: '#F5F8FA',
          100: '#E9F0F4',
          200: '#D5E1E9',
          300: '#B3C6D2',
          400: '#7F9AAA',
          500: '#557285',
          600: '#3D5768',
          700: '#2C4152',
          800: '#1B2B38',
          900: '#0F1922',
        },
        brand: {
          50: '#EAF4FB',
          100: '#D0E8F6',
          500: '#1580BC',
          600: '#0F6FA8',
          700: '#0B5581',
          800: '#083F60',
        },
        seat: {
          available: '#0E7F58',
          availableBg: '#E4F4EC',
          held: '#A96A05',
          heldBg: '#FBEEDA',
          booked: '#A93555',
          bookedBg: '#F9E2E9',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,40,55,.04), 0 8px 24px -14px rgba(15,40,55,.22)',
      },
    },
  },
  plugins: [],
};
