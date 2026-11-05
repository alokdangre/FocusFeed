.PHONY: build-ClassifierFunction build-JobWorkerFunction build-BillingApiFunction build-BillingWebhookFunction build-BillingWorkerFunction

build-ClassifierFunction build-JobWorkerFunction build-BillingApiFunction build-BillingWebhookFunction build-BillingWorkerFunction:
	python3 -m pip install -r requirements.txt --target "$(ARTIFACTS_DIR)" --no-compile
	python3 package_lambda.py "$(ARTIFACTS_DIR)"
