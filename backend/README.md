# FocusFeed classifier backend

This service validates video batches and classifies them with Strands Agents SDK and Amazon Bedrock. AWS credentials remain outside the browser extension.

## Local setup

Install AWS CLI v2 if `aws --version` is not available. On Linux/WSL, AWS's user-local installer does not require `sudo`:

```bash
curl -fsSL https://awscli.amazonaws.com/v2/install.sh | bash
aws --version
```

From the repository root:

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set `AWS_PROFILE` to the AWS CLI profile you want to use. The example deliberately contains no access key or secret. Configure credentials through the AWS CLI instead:

```bash
aws configure --profile focusfeed
```

If your AWS account uses IAM Identity Center, use `aws configure sso --profile focusfeed` followed by `aws sso login --profile focusfeed` instead. The profile needs permission to invoke the selected Bedrock model. Never put AWS credentials in the extension.

Confirm that the profile works before starting FocusFeed:

```bash
aws sts get-caller-identity --profile focusfeed
```

The IAM user or role behind that profile must also allow `bedrock:InvokeModel` for the Nova Micro inference profile and its US destination models. A least-privilege example is available at `backend/iam/focusfeed-bedrock-invoke-policy.example.json`. Replace `<ACCOUNT_ID>` with your AWS account ID and have an AWS administrator attach it to the local development identity. The Lambda deployment gets its own execution-role permission from `template.yaml`.

The defaults are:

```text
BEDROCK_REGION=us-east-1
BEDROCK_MODEL_ID=us.amazon.nova-micro-v1:0
```

The `us.` inference profile must be called from a supported US source region. Keep `BEDROCK_REGION=us-east-1` for this default model profile. Changing only the AWS CLI profile's default region does not override `BEDROCK_REGION` in this service.

Run the lightweight local adapter. The launcher reads `backend/.env` before starting Python:

```bash
bash backend/run_local.sh
```

The health endpoint is `http://127.0.0.1:3000/health`. Health checks do not invoke Bedrock or validate AWS credentials. `POST /classify` invokes the configured model and is the real credentials/model-access test.

## Bedrock troubleshooting

- `AccessDeniedException` for `bedrock:InvokeModel` means the AWS identity is missing the IAM permission described above.
- `ValidationException: Operation not allowed` in both the API and the `us-east-1` playground indicates an AWS account/service eligibility restriction. Serverless model access is automatic for commercial accounts with valid permissions, so create a free AWS Account and Billing support case when the playground also fails.

## Tests

The contract and handler tests use a fake agent and make no AWS calls:

```bash
python3 -m unittest discover -s backend/tests -v
```

## SAM

`template.yaml` is an infrastructure-as-code blueprint for the deployed backend. It tells AWS SAM to create an API Gateway HTTP API, a Python Lambda function, the `/health` and `/classify` routes, Lambda environment variables, and the IAM permission that lets the Lambda invoke Bedrock. The template does not deploy anything until `sam deploy` is run.

After installing AWS SAM CLI:

```bash
sam build --template-file backend/template.yaml
sam local start-api
```

For the first cloud deployment, use the guided flow:

```bash
sam deploy --guided
```

SAM transforms the template into AWS CloudFormation resources and prints the deployed API URL from the `ApiUrl` output. Deployment requires Bedrock model access in the configured region. Authentication and per-user allowances must be added before treating the API as public production infrastructure.
