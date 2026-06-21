# 使用Python 3.13作为基础镜像
FROM python:3.13

# 设置工作目录
WORKDIR /app

# 安装coscmd
RUN pip install coscmd

# 安装Node.js和npm
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    # 清理apt缓存以减小镜像大小
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 验证安装
RUN python --version && \
    pip --version && \
    node --version && \
    npm --version

# 设置默认命令
CMD ["bash"]