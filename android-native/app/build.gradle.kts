plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "cn.xuzf.tlg.core"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.xuzf.tlg.core"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0-native"

        // 只出 arm64：现代 Android 机均为 arm64，体积省约 60%（见 NATIVE-ANDROID.md）
        ndk {
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                // 与 ncnn 预编译库一致；不一致会出现 std::__ndk1::__hash_memory 未定义
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = libs.versions.cmake.get()
        }
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

    buildFeatures { compose = true }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // 模型文件可能较大，不要被压缩两次
        jniLibs.useLegacyPackaging = false
    }

    // 模型文件较大且因人而异，不进 git，由本地放入
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
}
