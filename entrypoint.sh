#!/bin/bash

if [ -d /ssh ]; then
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cp -rp /ssh/* ~/.ssh
chown -R $(id -u):$(id -g) ~/.ssh
fi

$@