cmake_minimum_required(VERSION 3.22)
project(tlg-native)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# STL 必须与 ncnn 预编译库一致：官方包用 c++_shared。
# 若用 c++_static，链接期会出现 std::__ndk1::__hash_memory 之类的未定义符号。
set(CMAKE_ANDROID_STL c++_shared)

# 只出 arm64-v8a（现代 Android 机均为 arm64），开启 NEON 与 CRC
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -fexceptions -frtti -funroll-loops")

# ---- ncnn ----
# 预编译库由 tools/download_ncnn.bat 解压到 third_party/ncnn/<版本>/
# 目录结构：third_party/ncnn/ncnn-<ver>/include 与 .../lib/android/arm64-v8a/libncnn.a
set(NCNN_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/ncnn" CACHE PATH "ncnn root")

file(GLOB NCNN_VER_DIRS "${NCNN_ROOT}/ncnn-*")
list(LENGTH NCNN_VER_DIRS _ncnn_dir_count)
if(_ncnn_dir_count EQUAL 0)
    message(FATAL_ERROR
        " 未找到 ncnn 预编译库。\n"
        " 请先执行：tools/download_ncnn.bat\n"
        " 它会下载 ncnn android 预编译包并解压到 third_party/ncnn/ 下。")
endif()
list(GET NCNN_VER_DIRS 0 NCNN_DIR)

set(NCNN_INCLUDE "${NCNN_DIR}/arm64-v8a/include/ncnn")
set(NCNN_LIB_DIR "${NCNN_DIR}/arm64-v8a/lib")

if(NOT EXISTS "${NCNN_LIB_DIR}/libncnn.a")
    message(FATAL_ERROR " 未找到 ${NCNN_LIB_DIR}/libncnn.a —— ncnn 预编译包不完整")
endif()

include_directories(${NCNN_INCLUDE})
link_directories(${NCNN_LIB_DIR})

add_library(tlg-native SHARED
        native-lib.cpp
        yolo11.cpp
        track_rules.cpp)

# ncnn 静态链接。预编译包还依赖 glslang（Vulkan 着色器编译）与 OpenMP，
# 两者都在同目录 lib/ 下，链接顺序要靠前的先列。
target_link_libraries(tlg-native
        ncnn
        glslang
        SPIRV
        OSDependent
        MachineIndependent
        GenericCodeGen
        glslang-default-resource-limits
        android
        log
        jnigraphics
        z)

# OpenMP：NDK 的 libomp 随 toolchain 提供
find_library(OMP_LIB omp PATHS ${CMAKE_SYSROOT}/usr/lib/aarch64-linux-android NO_DEFAULT_PATH)
if(OMP_LIB)
    target_link_libraries(tlg-native ${OMP_LIB})
else()
    target_link_options(tlg-native PRIVATE "-fopenmp")
endif()
