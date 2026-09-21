plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.plusultra.puppet"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.plusultra.puppet"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Never ship stale puppets: copy the web app next to the code on every build.
    sourceSets["main"].assets.srcDir("src/main/assets")
}

dependencies {
    // Only for WebViewAssetLoader — everything else is the Android framework.
    implementation("androidx.webkit:webkit:1.11.0")
}

/**
 * Bundle the web app (the repository root) into assets/www so Pip works offline
 * and gets a secure origin for the microphone and camera.
 */
val syncWebApp by tasks.registering(Copy::class) {
    val webRoot = rootProject.projectDir.parentFile
    from(webRoot) {
        include(
            "index.html",
            "sw.js",
            "manifest.webmanifest",
            "css/**",
            "js/**",
            "assets/**",
        )
        exclude("assets/icons/icon-512.png") // keep the APK small; icons are regenerable
    }
    into(layout.projectDirectory.dir("src/main/assets/www"))
}

tasks.named("preBuild") { dependsOn(syncWebApp) }
