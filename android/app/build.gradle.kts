import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseSigningValues = mapOf(
    "storeFile" to providers.gradleProperty("STUDYTRACE_UPLOAD_STORE_FILE")
        .orElse(providers.environmentVariable("STUDYTRACE_UPLOAD_STORE_FILE")).orNull,
    "storePassword" to providers.gradleProperty("STUDYTRACE_UPLOAD_STORE_PASSWORD")
        .orElse(providers.environmentVariable("STUDYTRACE_UPLOAD_STORE_PASSWORD")).orNull,
    "keyAlias" to providers.gradleProperty("STUDYTRACE_UPLOAD_KEY_ALIAS")
        .orElse(providers.environmentVariable("STUDYTRACE_UPLOAD_KEY_ALIAS")).orNull,
    "keyPassword" to providers.gradleProperty("STUDYTRACE_UPLOAD_KEY_PASSWORD")
        .orElse(providers.environmentVariable("STUDYTRACE_UPLOAD_KEY_PASSWORD")).orNull,
)
val hasReleaseSigning = releaseSigningValues.values.all { !it.isNullOrBlank() }

android {
    namespace = "edu.studytrace.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "edu.studytrace.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseSigningValues.getValue("storeFile")!!)
                storePassword = releaseSigningValues.getValue("storePassword")
                keyAlias = releaseSigningValues.getValue("keyAlias")
                keyPassword = releaseSigningValues.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            } else {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

val verifyReleaseSigning by tasks.registering {
    doLast {
        if (!hasReleaseSigning) {
            logger.warn(
                "Release signing is not configured. Falling back to debug signing config. " +
                    "To configure release signing, set STUDYTRACE_UPLOAD_STORE_FILE, " +
                    "STUDYTRACE_UPLOAD_STORE_PASSWORD, STUDYTRACE_UPLOAD_KEY_ALIAS, and " +
                    "STUDYTRACE_UPLOAD_KEY_PASSWORD as Gradle properties or environment variables."
            )
        }
    }
}

tasks.matching { it.name == "bundleRelease" || it.name == "assembleRelease" }.configureEach {
    dependsOn(verifyReleaseSigning)
}

dependencies {
    // 1.17.x is the newest Core line compatible with API 36 / AGP 8.10.
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
}
