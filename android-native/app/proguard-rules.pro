# ncnn 通过 JNI 反射调用，保留 native 方法所在的类
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep class cn.xuzf.tlg.core.detect.NativeBridge { *; }
