/**
 * Projet Gradle du worker Android NEXUS.
 *
 * Le greffon Gradle de React Native est pris depuis `node_modules` par
 * `includeBuild` — c'est la mecanique officielle de React Native, et elle evite
 * de dependre d'une version publiee separement de celle du paquet npm.
 *
 * Le chemin remonte a la racine du depot : dans un espace de travail pnpm, les
 * paquets sont installes dans le magasin partage `node_modules/.pnpm` et lies.
 */
pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("com.facebook.react.settings")
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "nexus-android-worker"
include(":app")

/*
 * Autolinking : volontairement vide.
 *
 * Le greffon React Native attend un fichier decrivant les bibliotheques natives
 * a lier automatiquement. Ce worker n'en a aucune : la seule est la sienne, et
 * elle est enregistree a la main dans `NexusWorkerApplication.getPackages()`.
 *
 * On ecrit donc le fichier plutot que de lancer `npx react-native config` : le
 * resultat serait le meme a chaque construction, mais dependrait du reseau et
 * de l'outil en ligne de commande. Surtout, ecrire « aucune dependance native »
 * est ici une DECISION, pas une decouverte — sur un appareil qui detient un
 * service d'accessibilite, une bibliotheque native ne doit pas pouvoir s'ajouter
 * par transitivite sans qu'on l'ecrive.
 */
val autolinking = file("build/generated/autolinking/autolinking.json")
autolinking.parentFile.mkdirs()
autolinking.writeText(
    """
    {
      "reactNativeVersion": "0.81.5",
      "dependencies": {},
      "project": { "android": { "packageName": "fr.nexus.worker" } }
    }
    """.trimIndent()
)
