# -*- coding: utf-8 -*-
"""下载 ncnn Android 预编译库（Vulkan 版）并解压到 third_party/ncnn/

用法：python tools/fetch_ncnn.py
依赖：Python 3.8+，无需第三方库
"""
import os
import urllib.request
import zipfile

# 版本可在 https://github.com/Tencent/ncnn/releases 查看
VER = "20240820"
URL = "https://github.com/Tencent/ncnn/releases/download/{v}/ncnn-{v}-android-vulkan.zip".format(v=VER)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(ROOT, "third_party", "ncnn")
CACHE = os.path.join(os.environ.get("TEMP", "."), "ncnn-android-vulkan.zip")


def main():
    os.makedirs(DEST, exist_ok=True)
    print("下载 %s" % URL)
    req = urllib.request.Request(URL, headers={"User-Agent": "tlg-native-build"})
    with urllib.request.urlopen(req, timeout=180) as resp, open(CACHE, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                print("  %d / %d MB" % (got >> 20, total >> 20))
    print("下载完成，开始解压")
    with zipfile.ZipFile(CACHE) as z:
        z.extractall(DEST)
    print("解压完成：%s" % DEST)
    for name in sorted(os.listdir(DEST)):
        print("   " + name)
    # 校验关键文件
    lib = os.path.join(DEST, "ncnn-%s-android-vulkan" % VER, "arm64-v8a", "lib", "libncnn.a")
    if not os.path.exists(lib):
        print("[警告] 未找到 %s，请检查解压结果" % lib)
    else:
        print("[校验] libncnn.a 就位（%.1f MB）" % (os.path.getsize(lib) / 1048576.0))


if __name__ == "__main__":
    main()
