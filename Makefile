# Kagura (神楽) — Declarative UI & 2D Stage Framework Makefile

GEISHA ?= geisha
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BUILD_DIR := $(ROOT_DIR)/build

.PHONY: all wasm native test serve clean

all: wasm native

wasm: $(BUILD_DIR)/dojo.wasm

$(BUILD_DIR)/dojo.wasm: src/*.gsa examples/dojo/app.gsa host/web/kagura.js
	@mkdir -p "$(BUILD_DIR)"
	cd "$(ROOT_DIR)/examples/dojo" && "$(GEISHA)" build --target wasm32 -o "$(BUILD_DIR)/dojo.wasm"

native: $(BUILD_DIR)/kagura-dojo

$(BUILD_DIR)/kagura-dojo: src/*.gsa examples/dojo/app.gsa host/native/kagura_macos.m
	@mkdir -p "$(BUILD_DIR)"
	cd "$(ROOT_DIR)/examples/dojo" && MACOSX_DEPLOYMENT_TARGET=14.0 "$(GEISHA)" build -o "$(BUILD_DIR)/kagura-dojo"

test: wasm native
	"$(GEISHA)" test
	"$(BUILD_DIR)/kagura-dojo" --headless-smoke

serve: wasm
	python3 -m http.server 8090 --directory "$(ROOT_DIR)"

clean:
	rm -rf "$(BUILD_DIR)" "$(ROOT_DIR)/examples/dojo/build"
