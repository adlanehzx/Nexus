# Procédure de test sur appareils physiques

## Pourquoi cette procédure existe

Tout ce qui précède est vérifié par des tests : la poignée de main, les
politiques, les coupures longues, la dictée. Aucun de ces tests ne touche un
appareil réel — ils ne peuvent pas. Trois choses ne se vérifient qu'avec du
matériel entre les mains :

1. **Les permissions du système.** Android et iOS demandent le micro, les
   notifications, l'accessibilité. Un refus de permission ne ressemble pas à un
   bug d'application : il ressemble à une application qui ne fait rien.
2. **Ce qui se passe quand l'écran s'éteint.** Un worker tué par
   l'optimisation de batterie, une socket fermée par le mode avion, un service
   d'accessibilité désactivé après une mise à jour du système.
3. **Le geste.** Scanner un QR, approuver une confirmation d'une main, parler à
   son téléphone dans une pièce bruyante. On ne mesure pas cela, on le constate.

Chaque section ci-dessous a un **critère observable**. Pas « vérifier que ça
marche », mais ce qu'on doit voir, et ce qu'on doit faire si on ne le voit pas.

## Avant de commencer

| à préparer                                                 | pourquoi                                               |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| une instance NEXUS joignable depuis le Wi-Fi du téléphone  | un téléphone qui scanne `localhost` s'appelle lui-même |
| `PUBLIC_API_URL` renseignée avec l'adresse du réseau local | sans elle, l'émission du QR est refusée                |
| un APK **signé**                                           | un APK non signé ne s'installe pas                     |
| le câble USB et `adb`                                      | sans journal, un échec sur téléphone est une devinette |

```sh
nexus doctor                 # l'installation est-elle saine ?
nexus policy check --path ~/  # que décide la politique locale ?
adb logcat -s NexusWorker:V  # ce que dit le worker, en direct
```

## 1. Appairage par QR

| étape                                          | critère observable                                                |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| afficher le QR depuis une surface authentifiée | la charge utile commence par `nexus://pair`                       |
| scanner avec le téléphone                      | l'appareil apparaît dans la liste, **non approuvé** et hors ligne |
| approuver                                      | l'appareil passe `TRUSTED`, puis `ONLINE` à la première session   |
| rescanner **le même** QR                       | refusé — un code ne sert qu'une fois                              |
| attendre 5 minutes, puis scanner               | refusé — le ticket a expiré                                       |

**Si l'appareil n'apparaît pas** : le téléphone n'atteint pas l'adresse du QR.
Depuis le téléphone, ouvrir `http://<adresse>:3000/api/v1/health` dans le
navigateur. Si cela échoue, c'est le réseau, pas NEXUS.

## 2. Permissions Android

| étape                                                                | critère observable                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| premier lancement                                                    | le système demande les notifications, et rien d'autre                                            |
| activer le service d'accessibilité                                   | l'écran de NEXUS le confirme, et la capacité `android.app.open` apparaît côté cœur               |
| **refuser** l'accessibilité                                          | les capacités correspondantes ne sont pas annoncées — et non annoncées puis refusées une par une |
| révoquer la permission depuis les réglages Android, worker en marche | le worker le détecte et retire la capacité, sans planter                                         |

Le dernier point est celui qui casse en pratique : une permission retirée
pendant l'exécution est silencieuse côté application.

## 3. Écran éteint, batterie, réseau

| étape                                           | critère observable                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| écran éteint 30 minutes, puis confier une tâche | elle arrive — ou elle échoue **franchement**, jamais « en cours » pour toujours                             |
| activer l'optimisation de batterie pour NEXUS   | le worker est tué ; au réveil il se reconnecte avec une poignée de main complète                            |
| mode avion 10 minutes                           | l'appareil passe hors ligne côté cœur, et une tâche confiée pendant ce temps est refusée au lieu d'attendre |
| couper le Wi-Fi au **milieu** d'une tâche       | la tâche échoue avec une raison lisible, et le résultat n'arrive pas deux fois après la reconnexion         |

Le dernier est le plus important, et c'est le seul que les tests de coupure
longue ne peuvent pas reproduire exactement : ils tuent un canal, pas une radio.

## 4. Confirmations

| étape                                                 | critère observable                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| déclencher une action à risque                        | la carte de confirmation arrive sur le téléphone, avec les arguments **réels** |
| approuver                                             | l'action s'exécute une seule fois                                              |
| refuser                                               | l'action ne s'exécute pas, et l'agent ne la retente pas                        |
| laisser expirer (2 min pour `CRITICAL`)               | l'action ne s'exécute pas, et le message le dit                                |
| approuver depuis un **autre** appareil du même compte | accepté — c'est la même personne                                               |

**Ce qui doit être impossible** : approuver une action `CRITICAL` à la voix. Si
c'est possible, c'est une régression.

## 5. Voix

| étape                                    | critère observable                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `nexus voice check`                      | les quatre dépendances sont nommées, présentes ou absentes                   |
| `nexus voice dictate --seconds 5`        | le texte apparaît, et `~/.nexus/audio-temporaire` est **vide** après         |
| dicter dans une pièce bruyante           | la transcription est mauvaise — c'est attendu ; elle ne doit pas être _vide_ |
| couper la parole pendant que NEXUS parle | le son s'arrête **immédiatement**, pas une seconde après                     |
| conversation mains libres, puis se taire | elle s'arrête d'elle-même                                                    |

Le dossier vide après dictée est le critère qui compte : c'est la seule
vérification de bout en bout de « aucun audio conservé » sur du matériel réel.

```sh
ls -la ~/.nexus/audio-temporaire    # doit être vide
```

## 6. Pause globale

| étape                         | critère observable                                               |
| ----------------------------- | ---------------------------------------------------------------- |
| mettre en pause               | une tâche confiée depuis le téléphone est refusée, avec le motif |
| lire pendant la pause         | les conversations et l'historique restent accessibles            |
| reprendre                     | la tâche suivante passe                                          |
| redémarrer l'API **en pause** | elle redémarre en pause, et le journal le dit                    |

## 7. Révocation

| étape                                   | critère observable                                                   |
| --------------------------------------- | -------------------------------------------------------------------- |
| révoquer l'appareil                     | il perd la connexion immédiatement, pas à l'expiration de sa session |
| relancer l'application sur le téléphone | elle ne se reconnecte pas                                            |
| réappairer avec un nouveau QR           | un **nouvel** appareil apparaît ; l'ancien reste `REVOKED`           |

## Que faire d'un échec

Noter trois choses : ce qui était attendu, ce qui s'est produit, et la ligne de
journal correspondante (`adb logcat`, Observateur d'événements, ou
`journalctl --user -u nexus-mission-engine`). Un rapport sans ligne de journal
coûte une reproduction complète à qui le lit.

Si l'échec est reproductible et que les tests automatisés passent, c'est que la
chose n'est pas testée — et c'est l'information la plus utile de toute cette
procédure.
