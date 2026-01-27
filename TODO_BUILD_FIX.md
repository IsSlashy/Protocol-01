# Fix Android Build - Chemins trop longs

## Problème
Le build Android échoue car les chemins Windows sont trop longs (>260 caractères) avec pnpm + react-native-reanimated.

## Solution: Renommer le dossier

1. **Fermer Claude Code** (il verrouille le dossier)

2. **Ouvrir un terminal Windows (cmd ou PowerShell en admin)**

3. **Exécuter:**
```cmd
cd P:\
ren "Protocol 01" P01
```

4. **Relancer Claude Code depuis `P:\P01`**

5. **Lancer le build:**
```bash
cd P:\P01\apps\mobile
npx expo run:android
```

## Alternative: Ouvrir le pare-feu

Si vous ne voulez pas renommer:

1. Ouvrir PowerShell **en administrateur**
2. Exécuter:
```powershell
New-NetFirewallRule -DisplayName "Metro Bundler" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow
```
3. Lancer Metro: `npx expo start --dev-client`
4. Sur le téléphone DevLauncher, entrer: `http://192.168.1.5:8081`

## Infos utiles
- Disque C: était plein, nettoyé le cache Gradle (~5GB libérés)
- GRADLE_USER_HOME configuré sur P:/.gradle
- App installée: com.protocol01.app
- Device connecté: 0019235AU004508
