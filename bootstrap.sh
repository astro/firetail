#!/usr/bin/env bash

# No failures allowed
set -e

for dep in node-base64 node-expat ; do
    cd deps/$dep
    [ -d build/default ] || mkdir -p build/default
    node-waf configure
    node-waf build
    cd -
done

