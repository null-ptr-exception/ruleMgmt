#!/bin/sh
set -e

if [ -d /data/gitops/.git ]; then
  echo "Workspace already initialized, skipping clone"
  chown -R 1000:1000 /data/gitops
  exit 0
fi

REPO_URL="https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}/${GITLAB_PROJECT}.git"
USER_BRANCH="rulemgmt/${JUPYTERHUB_USER}"

if git ls-remote --heads "$REPO_URL" "$USER_BRANCH" 2>/dev/null | grep -q .; then
  echo "Cloning existing branch: $USER_BRANCH"
  git clone -b "$USER_BRANCH" "$REPO_URL" /data/gitops
else
  echo "Creating new branch: $USER_BRANCH"
  git clone "$REPO_URL" /data/gitops
  cd /data/gitops
  git checkout -b "$USER_BRANCH"
fi

cd /data/gitops
git config user.name "$JUPYTERHUB_USER"
git config user.email "${JUPYTERHUB_USER}@rulemgmt"

chown -R 1000:1000 /data/gitops
