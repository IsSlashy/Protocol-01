# JP Translate — sites japonais + prix JPY → USD/EUR

Extension navigateur (Chrome / **Opera GX** / Edge / Brave) qui, **en un seul bouton ON/OFF** :

- traduit automatiquement le texte japonais de la page que tu consultes ;
- ajoute le prix en **USD / EUR** à côté de chaque montant en yens (¥ / 円).

Pensée pour réserver moins cher sur les sites japonais (Rakuten Travel, Jalan, Ikyu…) plutôt que sur booking.com.

Aucune IA, aucune clé API à fournir. Traduction via le service public de Google Translate, taux de change via `frankfurter.app` (BCE).

## Installation (non empaquetée)

### Opera GX
1. Ouvre `opera://extensions`.
2. Active **Mode développeur** (en haut à droite).
3. Clique **Charger une extension non empaquetée** (*Load unpacked*).
4. Sélectionne le dossier `jp-translate-extension`.

### Chrome / Edge / Brave
1. Ouvre `chrome://extensions` (ou `edge://extensions`).
2. Active **Mode développeur**.
3. **Charger l'extension non empaquetée** → sélectionne ce dossier.

> Astuce : épingle l'extension à la barre d'outils pour accéder au bouton.

## Utilisation

1. Ouvre une page japonaise.
2. Clique l'icône de l'extension → bascule sur **ON**.
3. La page est traduite et les prix affichent l'équivalent USD/EUR.
4. **OFF** restaure instantanément le texte original.

Tu peux choisir la **langue de traduction** et la **devise** dans le popup.

> Les onglets déjà ouverts **avant** l'installation : recharge-les une fois (F5). Les nouveaux onglets fonctionnent directement.

## Fonctionnement

| Fichier | Rôle |
|---|---|
| `manifest.json` | Déclaration MV3, permissions, content script |
| `content.js` | Parcourt la page, traduit le japonais, convertit les prix, observe le contenu dynamique, gère le revert |
| `background.js` | Service worker : proxy de traduction (évite les soucis CORS) + taux de change mis en cache |
| `popup/` | Le bouton ON/OFF et les réglages |
| `icons/`, `generate-icons.js` | Icônes (régénérables avec `node generate-icons.js`) |

## Confidentialité

Les textes japonais visibles de la page sont envoyés à Google Translate pour traduction (comme l'option « traduire » du navigateur). Les taux de change proviennent de `frankfurter.app`. Aucune autre donnée n'est collectée ni stockée hors de ton navigateur.

## Limites connues

- Le format portable de la traduction conserve la structure HTML (liens, images) ; seuls les textes changent.
- Très longues pages : la traduction se fait par lots, en arrière-plan.
- La version « portable » de devise (USD/EUR) est indicative (taux BCE quotidiens).
