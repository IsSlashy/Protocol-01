import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthDemoPage from '@/app/demo/auth/page';

describe('AuthDemoPage -- QR-based wallet authentication flow', () => {
  beforeEach(() => {
    sessionStorage.clear();
    render(<AuthDemoPage />);
  });

  describe('Page Header', () => {
    it('displays the "P01 Auth Demo" title', () => {
      expect(screen.getByText('P01 Auth Demo')).toBeInTheDocument();
    });

    it('shows "Login with Protocol 01" subtitle', () => {
      expect(screen.getByText('Login with Protocol 01')).toBeInTheDocument();
    });

    it('has a link back to the homepage', () => {
      const backLink = screen.getByText(/Retour/);
      expect(backLink.closest('a')).toHaveAttribute('href', '/');
    });
  });

  describe('Service Configuration Panel', () => {
    it('displays "Configuration Service" heading', () => {
      expect(screen.getByText('Configuration Service')).toBeInTheDocument();
    });

    it('shows service name input defaulting to "Netflix Demo"', () => {
      const input = screen.getByDisplayValue('Netflix Demo');
      expect(input).toBeInTheDocument();
    });

    it('allows changing the service name', async () => {
      const user = userEvent.setup();
      const input = screen.getByDisplayValue('Netflix Demo');
      await user.clear(input);
      await user.type(input, 'Spotify Demo');
      expect(input).toHaveValue('Spotify Demo');
    });

    it('has a subscription verification toggle', () => {
      expect(screen.getByText(/Vérifier abonnement/)).toBeInTheDocument();
    });

    it('renders the "Générer QR Code" button', () => {
      expect(screen.getByText('Générer QR Code')).toBeInTheDocument();
    });
  });

  describe('QR Code Generation', () => {
    it('shows placeholder text before QR generation', () => {
      expect(screen.getByText(/Cliquez sur .* pour commencer/)).toBeInTheDocument();
    });

    it('displays initial "Scannez pour vous connecter" heading', () => {
      expect(screen.getByText('Scannez pour vous connecter')).toBeInTheDocument();
    });

    it('generates QR code when button is clicked', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      // After generation, QR code component should be rendered
      expect(screen.getByTestId('qr-code')).toBeInTheDocument();
    });

    it('generates a p01:// deep link for the QR code', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      const qrCode = screen.getByTestId('qr-code');
      const value = qrCode.getAttribute('data-value');
      expect(value).toContain('p01://auth?payload=');
    });

    it('shows "En attente de connexion..." status after QR generation', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      expect(screen.getByText(/En attente de connexion/)).toBeInTheDocument();
    });
  });

  describe('Debug and Simulation Panel', () => {
    it('shows the "Simuler Auth Réussie" button after QR generation', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      expect(screen.getByText('Simuler Auth Réussie')).toBeInTheDocument();
    });

    it('shows "Connecté!" status after simulating successful auth', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));
      await user.click(screen.getByText('Simuler Auth Réussie'));

      expect(screen.getByText(/Connecté!/)).toBeInTheDocument();
    });

    it('displays the authenticated wallet address after successful auth', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));
      await user.click(screen.getByText('Simuler Auth Réussie'));

      // The completed state shows "Authentifié!" and the wallet truncated
      expect(screen.getByText(/Authentifié/)).toBeInTheDocument();
    });
  });

  describe('Logs Panel', () => {
    it('renders the LOGS section', () => {
      expect(screen.getByText('LOGS')).toBeInTheDocument();
    });

    it('shows "En attente..." initially', () => {
      expect(screen.getByText('En attente...')).toBeInTheDocument();
    });

    it('populates logs after QR generation', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      expect(screen.getByText(/Session créée/)).toBeInTheDocument();
      expect(screen.getByText(/Challenge/)).toBeInTheDocument();
    });
  });

  describe('Deep Link Section', () => {
    it('shows the DEEP LINK section after QR generation', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      expect(screen.getByText('DEEP LINK')).toBeInTheDocument();
    });

    it('displays the deep link section with a copy button', async () => {
      const user = userEvent.setup();
      await user.click(screen.getByText('Générer QR Code'));

      // The deep link section has a "Copier" button
      expect(screen.getByText(/Copier/)).toBeInTheDocument();
    });
  });

  describe('How It Works Section', () => {
    it('displays "Comment ca marche?" heading', () => {
      expect(screen.getByText('Comment ça marche?')).toBeInTheDocument();
    });

    it('shows Step 1: Scanner', () => {
      expect(screen.getByText('1. Scanner')).toBeInTheDocument();
    });

    it('shows Step 2: Vérifier', () => {
      expect(screen.getByText('2. Vérifier')).toBeInTheDocument();
    });

    it('shows Step 3: Confirmer', () => {
      expect(screen.getByText('3. Confirmer')).toBeInTheDocument();
    });

    it('shows Step 4: Connecté', () => {
      expect(screen.getByText('4. Connecté')).toBeInTheDocument();
    });
  });

  describe('SDK Integration Code Example', () => {
    it('displays "Intégration SDK" heading', () => {
      expect(screen.getByText('Intégration SDK')).toBeInTheDocument();
    });

    it('shows P01AuthClient import in code example', () => {
      expect(screen.getByText(/P01AuthClient/)).toBeInTheDocument();
    });

    it('shows createSession() in code example', () => {
      expect(screen.getByText(/createSession/)).toBeInTheDocument();
    });
  });
});
